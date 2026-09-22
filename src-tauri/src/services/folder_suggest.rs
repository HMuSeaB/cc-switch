//! 供应商文件夹智能分组建议
//!
//! 用 TypeSafe System One 的 `choice` 原语判断「这个未分组供应商该进哪个文件夹」。
//!
//! 关键设计：
//! 1. **criteria 必须含 `__none__`（未分组）**。不给模型"放弃归组"的选项，
//!    它就会强行把每个供应商塞进某个文件夹——包括明显不属于任何一组的。
//! 2. **一次请求问 N 个 question**（每个供应商一个），共享同一份 state。
//!    这是 TypeSafe skill 明确建议的并行模式：N 次串行请求又慢又贵。
//! 3. **按 confidence 分流**：高置信度标为可直接采纳，低置信度标为待人工确认。
//!    置信度反映概率分布的集中程度，不是"对不对"的保证——所以永远由人最终拍板。
//! 4. **必须能降级**：没配 key / 请求失败 / 没有可归组对象时，走本地启发式或
//!    直接返回空，绝不让智能分组阻塞供应商列表。

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};

use crate::provider::Provider;
use crate::services::typesafe::{ChoiceResult, TypeSafeClient, TypeSafeConfig};

/// choice 里代表「未分组」的特殊选项 id。
/// 用这个而不是空字符串：空串在概率分布里容易被忽略，且语义不明确。
pub const NONE_OPTION_ID: &str = "__none__";

/// 置信度阈值：达到就算"可以直接采纳"的建议。
/// 0.75 是 JEV 控制台默认的"高置信度直接采纳"线，这里沿用同一个量级。
pub const HIGH_CONFIDENCE: f64 = 0.75;
/// 低于此值的建议基本是噪声，标为低置信度让用户自己判断。
pub const LOW_CONFIDENCE: f64 = 0.5;

/// 单条归组建议
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSuggestion {
    pub provider_id: String,
    pub provider_name: String,
    /// 建议的文件夹名。`None` 表示建议保持未分组（对应 `__none__`）。
    pub suggested_folder: Option<String>,
    /// 归一后的置信度 0..1
    pub confidence: f64,
    /// 是否高置信度（>= [`HIGH_CONFIDENCE`]）。前端可据此默认勾选、
    /// 低置信度的默认不勾选，减少用户的审查负担。
    pub high_confidence: bool,
    /// `suggested_folder` 是否指向一个**尚不存在**的文件夹（采纳时会新建）。
    /// 前端据此给个"新建"标记，让用户清楚这条建议会创建分组。
    pub is_new_folder: bool,
    /// 该供应商在全部候选文件夹上的概率分布（含 `__none__`），按概率降序。
    /// 给前端展示"第二选择是什么"，帮用户判断要不要改判。
    pub alternatives: Vec<FolderProbability>,
    /// 建议来源：`typesafe`（模型）或 `heuristic`（本地降级）
    pub source: SuggestionSource,
}

/// 概率分布里的一项
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderProbability {
    /// 文件夹名；`None` = 未分组
    pub folder: Option<String>,
    pub probability: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SuggestionSource {
    TypeSafe,
    Heuristic,
}

/// 一次智能分组的整体结果
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FolderSuggestResult {
    pub suggestions: Vec<FolderSuggestion>,
    /// 实际用了哪条路径。前端据此提示用户"当前是本地启发式，未调用模型"。
    pub source: SuggestionSource,
    /// 降级原因（走了启发式时说明为什么没走模型）
    pub degraded_reason: Option<String>,
    /// token 用量（走模型时才有）
    pub usage: Option<(u64, u64)>,
}

/// 参与智能分组的输入
pub struct SuggestInput<'a> {
    /// 未分组的供应商（已过滤掉 folder 非空的）
    pub ungrouped: Vec<&'a Provider>,
    /// 现有文件夹名（注册表 + 已占用名）
    pub existing_folders: Vec<String>,
    /// 允许建议**新**文件夹时，从供应商地址派生出的候选名。
    ///
    /// 与 `existing_folders` 的关键区别：这些名字注册表里还没有，命中它们
    /// 意味着"建一个新文件夹"。调用方（DAO）会用
    /// `set_providers_folder_ensure` 在落库时补登记。
    ///
    /// 空 vec = 不允许建新文件夹（退化回旧的封闭候选集行为）。
    pub derived_folders: Vec<String>,
    pub config: TypeSafeConfig,
}

/// 生成智能分组建议。
///
/// 流程：有 key → 调模型；失败/无 key → 本地启发式；两者都空 → 返回空列表。
pub async fn suggest_folders(input: SuggestInput<'_>) -> FolderSuggestResult {
    if input.ungrouped.is_empty() {
        return FolderSuggestResult {
            suggestions: Vec::new(),
            source: SuggestionSource::Heuristic,
            degraded_reason: Some("没有未分组的供应商".to_string()),
            usage: None,
        };
    }

    // 候选集 = 已有文件夹 ∪ 派生的新文件夹名。
    //
    // 派生名不是让模型自由发挥：它们是从供应商自己的官网/请求地址里抽出来的，
    // 集合封闭、可枚举，模型依然只能从给定选项里选。这样即使注册表是空的，
    // 智能分组也有意义——第一次用就能得到一批按域名归好的组。
    let mut candidates = input.existing_folders.clone();
    for name in &input.derived_folders {
        if !candidates.iter().any(|f| f == name) {
            candidates.push(name.clone());
        }
    }

    if candidates.is_empty() {
        // 一个候选都没有（没有已有文件夹，也从地址里抽不出任何名字）：
        // 这时候确实无能为力，说明白让用户先建一个。
        return FolderSuggestResult {
            suggestions: Vec::new(),
            source: SuggestionSource::Heuristic,
            degraded_reason: Some("还没有任何文件夹，请先新建文件夹".to_string()),
            usage: None,
        };
    }

    let new_folder_names: Vec<String> = candidates
        .iter()
        .filter(|c| !input.existing_folders.iter().any(|f| f == *c))
        .cloned()
        .collect();

    if !input.config.is_configured() {
        return degraded(
            heuristic_suggest(&input.ungrouped, &candidates),
            "未配置 TypeSafe API Key，已使用本地启发式".to_string(),
        );
    }

    let client = TypeSafeClient::new(input.config.clone());
    match typesafe_suggest(&client, &input.ungrouped, &candidates, &new_folder_names).await {
        Ok(result) => result,
        Err(err) => {
            log::warn!("[FolderSuggest] TypeSafe 调用失败，降级到本地启发式: {err}");
            degraded(
                heuristic_suggest(&input.ungrouped, &candidates),
                format!("TypeSafe 调用失败，已使用本地启发式: {err}"),
            )
        }
    }
}

fn degraded(suggestions: Vec<FolderSuggestion>, reason: String) -> FolderSuggestResult {
    FolderSuggestResult {
        suggestions,
        source: SuggestionSource::Heuristic,
        degraded_reason: Some(reason),
        usage: None,
    }
}

/// 走 TypeSafe 的一次性判定。
///
/// `candidates` 是完整的封闭选项集（已有 ∪ 派生），模型只能从中选；
/// `new_folder_names` 是其中"注册表里还没有"的那部分，仅用于给建议打
/// `is_new_folder` 标记，不参与请求构造。
async fn typesafe_suggest(
    client: &TypeSafeClient,
    ungrouped: &[&Provider],
    candidates: &[String],
    new_folder_names: &[String],
) -> Result<FolderSuggestResult, String> {
    // criteria：选项 id -> 该选项的含义。
    // 每个候选文件夹一个选项；`__none__` 永远在最后，语义写清楚"不属于任何一组"。
    let mut criteria: IndexMap<String, String> = IndexMap::new();
    for name in candidates {
        // 派生名在注册表里还不存在，含义里点明"这将新建一个文件夹"，
        // 免得模型以为它和已有文件夹是同一类东西而不敢选。
        if new_folder_names.iter().any(|n| n == name) {
            criteria.insert(name.clone(), format!("新文件夹「{name}」（采纳时会创建）"));
        } else {
            criteria.insert(name.clone(), format!("文件夹「{name}」"));
        }
    }
    criteria.insert(
        NONE_OPTION_ID.to_string(),
        "不属于以上任何一个文件夹，保持未分组".to_string(),
    );

    let instructions = build_instructions(ungrouped, candidates);
    let state = build_state(ungrouped, candidates, new_folder_names);

    // question id 用 provider id；同一次请求里并行发出
    let keys: Vec<String> = ungrouped.iter().map(|p| p.id.clone()).collect();
    let answered = client
        .choices(state, instructions, &keys, &criteria)
        .await?;

    let mut suggestions = Vec::with_capacity(ungrouped.len());
    let mut any_answered = false;

    for (index, provider) in ungrouped.iter().enumerate() {
        let Some(choice) = answered.results.get(index).and_then(|a| a.as_ref()) else {
            // 这个供应商没拿到答案：不给建议，让用户自己决定
            continue;
        };
        any_answered = true;

        suggestions.push(build_suggestion(
            provider,
            choice,
            candidates,
            new_folder_names,
        ));
    }

    // 一个答案都没回来，说明响应结构和预期不符——当作失败降级，别给用户看空列表
    if !any_answered {
        return Err("TypeSafe 未返回任何有效答案".to_string());
    }

    Ok(FolderSuggestResult {
        suggestions,
        source: SuggestionSource::TypeSafe,
        degraded_reason: None,
        usage: answered.usage,
    })
}

fn build_suggestion(
    provider: &Provider,
    choice: &ChoiceResult,
    candidates: &[String],
    new_folder_names: &[String],
) -> FolderSuggestion {
    let is_none = choice.selected == NONE_OPTION_ID;
    let suggested_folder = if is_none {
        None
    } else {
        Some(choice.selected.clone())
    };

    // 概率分布：把选项 id 映射回文件夹名，`__none__` 映射成 None，按概率降序
    let mut alternatives: Vec<FolderProbability> = choice
        .probabilities
        .iter()
        .map(|(id, p)| FolderProbability {
            folder: if id == NONE_OPTION_ID {
                None
            } else {
                Some(id.clone())
            },
            probability: *p,
        })
        .collect();
    alternatives.sort_by(|a, b| {
        b.probability
            .partial_cmp(&a.probability)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // 模型有时会返回一个不在候选里的名字（幻觉）。这种建议不可信：
    // 归一成"未分组"并把置信度压到低档，让用户看出来有问题。
    let (suggested_folder, confidence) = match &suggested_folder {
        Some(name) if !candidates.iter().any(|f| f == name) => {
            log::warn!(
                "[FolderSuggest] 模型返回了不存在的文件夹「{name}」，按未分组处理: provider={}",
                provider.id
            );
            (None, choice.confidence.min(LOW_CONFIDENCE))
        }
        _ => (suggested_folder, choice.confidence),
    };

    // 采纳这条建议会不会新建文件夹：命中的是派生名（注册表里还没有）。
    let is_new_folder = suggested_folder
        .as_ref()
        .is_some_and(|f| new_folder_names.iter().any(|n| n == f));

    FolderSuggestion {
        provider_id: provider.id.clone(),
        provider_name: provider.name.clone(),
        suggested_folder,
        confidence,
        high_confidence: confidence >= HIGH_CONFIDENCE,
        is_new_folder,
        alternatives,
        source: SuggestionSource::TypeSafe,
    }
}

/// 组装 instructions：把"要判断什么"讲清楚，并给出可对照的候选清单。
fn build_instructions(ungrouped: &[&Provider], existing_folders: &[String]) -> String {
    let mut s = String::new();
    s.push_str("判断每个未分组的供应商应该归入哪个文件夹。\n");
    s.push_str("可用文件夹：");
    s.push_str(&existing_folders.join("、"));
    s.push_str("。\n");
    s.push_str(&format!(
        "如果某个供应商明显不属于任何文件夹，选择「{NONE_OPTION_ID}」保持未分组，不要勉强归类。\n"
    ));
    s.push_str("判断依据：名称、官网/请求地址、备注所反映的用途与性质（官方直连 / 中转聚合 / 特定模型生态等）。\n");
    s.push_str(&format!("共 {} 个供应商，请逐个判断：\n", ungrouped.len()));

    for (index, provider) in ungrouped.iter().enumerate() {
        s.push_str(&format!(
            "- [{}] {}\n",
            index + 1,
            describe_provider(provider)
        ));
    }

    s
}

/// 把单个供应商压成一行紧凑描述，作为模型的判断依据。
fn describe_provider(provider: &Provider) -> String {
    let mut parts: Vec<String> = vec![format!("id={}", provider.id)];

    parts.push(format!("名称={}", provider.name));

    if let Some(url) = &provider.website_url {
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            parts.push(format!("官网={trimmed}"));
        }
    }

    if let Some(url) = extract_base_url(provider) {
        parts.push(format!("请求地址={url}"));
    }

    if let Some(category) = &provider.category {
        parts.push(format!("分类={category}"));
    }

    if let Some(notes) = &provider.notes {
        let trimmed = notes.trim();
        if !trimmed.is_empty() {
            // 备注可能很长，截断到 120 字，避免把 prompt 撑爆
            let clipped: String = trimmed.chars().take(120).collect();
            parts.push(format!("备注={clipped}"));
        }
    }

    parts.join(" | ")
}

/// 从 settingsConfig 里抽 base_url。抽不到返回 None。
///
/// 只做最常见几种形态的浅抽取，不引完整 URL 解析——这只是给模型看的线索，
/// 不需要精确；抽不到顶多少一条依据。
fn extract_base_url(provider: &Provider) -> Option<String> {
    let config = provider.settings_config.as_object()?;

    let candidates = [
        config.get("baseUrl").and_then(|v| v.as_str()),
        config.get("base_url").and_then(|v| v.as_str()),
        config.get("endpoint").and_then(|v| v.as_str()),
        config.get("api_base").and_then(|v| v.as_str()),
    ];
    if let Some(url) = candidates.into_iter().flatten().next() {
        let trimmed = url.trim();
        if !trimmed.is_empty() {
            return Some(trimmed.to_string());
        }
    }

    // Claude 形态：env.ANTHROPIC_BASE_URL
    let env = config.get("env")?.as_object()?;
    for key in [
        "ANTHROPIC_BASE_URL",
        "OPENAI_BASE_URL",
        "GOOGLE_GEMINI_BASE_URL",
        "BASE_URL",
    ] {
        if let Some(url) = env.get(key).and_then(|v| v.as_str()) {
            let trimmed = url.trim();
            if !trimmed.is_empty() {
                return Some(trimmed.to_string());
            }
        }
    }

    None
}

/// 从一组未分组供应商自身派生出候选文件夹名。
///
/// 这是"注册表是空的也能用智能分组"的关键：名字不是模型编的，是从供应商
/// 自己的官网/请求地址里抽出来的域名根。抽出来的是封闭集合，模型照样只能
/// 从给定选项里选，所以幻觉风险没有变化。
///
/// 刻意做成保守：
/// - **只用官网域名**（`website_url`），不用 `settings_config` 里的 base_url。
///   后者对中转/代理用户来说全是 `127.0.0.1:4000` 这类地址，拿它建组会得到
///   一个叫"127.0.0.1"的文件夹，毫无意义。
/// - **IP / localhost 一律跳过**：同理，本地中转地址不构成"服务商"。
/// - **只保留 >= 2 个供应商共用的域名根**：只出现一次的域名建单个文件夹，
///   只会让文件夹列表更长而没有任何分组收益。这些保持未分组更干净。
/// - 返回结果按组内供应商数降序，让"大组"先出现在候选里。
pub fn derive_folder_names_from_providers(ungrouped: &[&Provider]) -> Vec<String> {
    use std::collections::HashMap;

    // 域名根 -> 落在它上面的供应商 id（用 Vec 保序去重，不用 HashSet 打乱顺序）
    let mut groups: HashMap<String, Vec<String>> = HashMap::new();
    for provider in ungrouped {
        let Some(root) = provider.website_url.as_deref().and_then(domain_root_of) else {
            continue;
        };
        let entry = groups.entry(root).or_default();
        if !entry.iter().any(|id| id == &provider.id) {
            entry.push(provider.id.clone());
        }
    }

    // >= 2 个才算一个候选文件夹，避免为单个供应商建一堆空壳组
    let mut derived: Vec<(String, usize)> = groups
        .into_iter()
        .filter(|(_, ids)| ids.len() >= 2)
        .map(|(root, ids)| (root, ids.len()))
        .collect();

    derived.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    derived.into_iter().map(|(root, _)| root).collect()
}

/// 从一个 URL 里抽"域名根"作为文件夹名。返回 None 表示这个 URL 不该建组。
///
/// 规则：
/// - 解析不出 host → None
/// - `localhost` / 字面 IP（v4/v6）→ None（本地中转，不是服务商）
/// - 取可注册域名级别的最后两段，`www.` 前缀剥掉
/// - 结果统一转小写
fn domain_root_of(url: &str) -> Option<String> {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return None;
    }

    // 浅抽 host：scheme://host[:port][/path]。不引完整 URL 解析器——这里的
    // 输入几乎都是用户手填的 URL，畸形是常态，抽不到就跳过。
    let after_scheme = match trimmed.split_once("://") {
        Some((_, rest)) => rest,
        None => trimmed,
    };
    let host_port = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or(after_scheme);
    // 去掉 userinfo（http://user:pass@host/）——账号密码里出现 @ 是合法的
    let host = host_port.rsplit('@').next().unwrap_or(host_port);
    // 去掉端口；IPv6 字面量形如 [::1]:8080，先剥方括号
    let host = host
        .strip_prefix('[')
        .map_or(host, |h| h.split(']').next().unwrap_or(h));
    let host = host.split(':').next().unwrap_or(host);

    if host.is_empty() || host.eq_ignore_ascii_case("localhost") {
        return None;
    }

    // 字面 IPv4：四段全数字
    let is_ipv4 = host.split('.').count() == 4
        && host
            .split('.')
            .all(|seg| !seg.is_empty() && seg.bytes().all(|b| b.is_ascii_digit()));
    if is_ipv4 || host.contains(':') {
        return None;
    }

    let labels: Vec<&str> = host.split('.').filter(|s| !s.is_empty()).collect();
    match labels.len() {
        0 | 1 => None,
        2 => Some(labels.join(".")),
        _ => {
            // 处理 co.uk / com.cn 这类二级后缀：再多往前取一段，
            // 否则 "api.example.co.uk" 会退化成 "co.uk"，把不同服务商混到一起。
            let take = if labels[labels.len() - 2].len() <= 3 {
                3
            } else {
                2
            };
            Some(labels[labels.len() - take..].join("."))
        }
    }
    .map(|s| s.to_lowercase())
}

/// 组装 state：命名 JSON 字段，让模型看到结构化上下文而不只是一段话。
///
/// `new_folder_names` 非空时，constraints 从"不能发明新文件夹"改成
/// "优先归入已有文件夹，确实都不合适才从给出的新候选里挑"，并把这些候选
/// 单独列出来。集合依然是封闭的——模型只能选列出的名字。
fn build_state(
    ungrouped: &[&Provider],
    candidates: &[String],
    new_folder_names: &[String],
) -> serde_json::Value {
    let constraints: Vec<String> = if new_folder_names.is_empty() {
        vec![
            "只能选择给出的文件夹名，不能发明新文件夹".to_string(),
            "明显不属于任何一组的选未分组，不要勉强归类".to_string(),
            "同一性质的供应商应保持分组一致".to_string(),
        ]
    } else {
        vec![
            "优先归入已存在的文件夹，不要轻易新建".to_string(),
            "确实不属于任何已有文件夹时，才从 new_folder_candidates 里挑一个".to_string(),
            "同一性质的供应商应保持分组一致（包括新建的那个）".to_string(),
            "只能选择给出的文件夹名，不能自己编造名字".to_string(),
            "明显不属于任何一组的选未分组，不要勉强归类".to_string(),
        ]
    };

    serde_json::json!({
        "project": "cc-switch",
        "goal": "把未分组的供应商归入最合适的文件夹",
        "context": {
            "ungrouped_count": ungrouped.len(),
            "existing_folders": candidates,
            "new_folder_candidates": new_folder_names,
            "providers": ungrouped.iter().map(|p| serde_json::json!({
                "id": p.id,
                "name": p.name,
                "websiteUrl": p.website_url,
                "category": p.category,
                "baseUrl": extract_base_url(p),
                "notes": p.notes,
            })).collect::<Vec<_>>(),
        },
        "constraints": constraints,
    })
}

// --- 本地启发式降级 ---

/// 无 key / 调用失败时的兜底：按「URL 域名 + 名称关键词」与现有文件夹名做匹配。
///
/// 刻意做得很笨：只做子串包含匹配，不引入模糊算法。它的职责是"能用"而不是
/// "聪明"——真正聪明的判断交给 TypeSafe。
fn heuristic_suggest(
    ungrouped: &[&Provider],
    existing_folders: &[String],
) -> Vec<FolderSuggestion> {
    let mut suggestions = Vec::new();

    for provider in ungrouped {
        let haystack = build_heuristic_haystack(provider);
        let haystack_lower = haystack.to_lowercase();

        // 找匹配度最高的文件夹：以「匹配到的字符长度」计分，
        // 这样「DeepSeek 官方」比「官方」更具体的那个胜出。
        let mut best: Option<(String, usize)> = None;
        for folder in existing_folders {
            let folder_trimmed = folder.trim();
            if folder_trimmed.is_empty() {
                continue;
            }
            let score = match_score(&haystack_lower, &folder_trimmed.to_lowercase());
            if score == 0 {
                continue;
            }
            match &best {
                Some((_, best_score)) if *best_score >= score => {}
                _ => best = Some((folder.clone(), score)),
            }
        }

        let (suggested_folder, confidence) = match best {
            // 启发式命中的置信度统一压到中低档：它只是字面匹配，
            // 不该和模型判断一样被当成高置信建议。
            Some((folder, _)) => (Some(folder), 0.6),
            None => (None, 0.0),
        };

        suggestions.push(FolderSuggestion {
            provider_id: provider.id.clone(),
            provider_name: provider.name.clone(),
            suggested_folder,
            confidence,
            high_confidence: confidence >= HIGH_CONFIDENCE,
            is_new_folder: false,
            alternatives: Vec::new(),
            source: SuggestionSource::Heuristic,
        });
    }

    suggestions
}

/// 把供应商的可匹配文本拼成一个小写化的"干草堆"。
fn build_heuristic_haystack(provider: &Provider) -> String {
    let mut parts: Vec<String> = vec![provider.name.clone()];

    if let Some(url) = &provider.website_url {
        parts.push(url.clone());
    }
    if let Some(url) = extract_base_url(provider) {
        parts.push(url.clone());
    }
    if let Some(category) = &provider.category {
        parts.push(category.clone());
    }
    if let Some(notes) = &provider.notes {
        parts.push(notes.clone());
    }

    parts.join(" ")
}

/// 计算 folder 名在 haystack 里的匹配得分（0 = 不匹配）。
///
/// 文件夹名可能含空格分隔的多个词（如「主力 官方」）：任一词命中即算匹配，
/// 得分取命中词的长度之和——多词全中比单词命中分高。
fn match_score(haystack_lower: &str, folder_lower: &str) -> usize {
    let mut total = 0usize;
    let mut any = false;
    for token in folder_lower.split_whitespace() {
        if token.is_empty() {
            continue;
        }
        if haystack_lower.contains(token) {
            total += token.chars().count();
            any = true;
        }
    }
    if any {
        total
    } else {
        0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn provider(id: &str, name: &str, base_url: Option<&str>) -> Provider {
        Provider {
            id: id.to_string(),
            name: name.to_string(),
            settings_config: match base_url {
                Some(u) => json!({ "baseUrl": u }),
                None => json!({}),
            },
            website_url: None,
            category: None,
            created_at: None,
            sort_index: None,
            notes: None,
            meta: None,
            icon: None,
            icon_color: None,
            in_failover_queue: false,
            folder: None,
        }
    }

    #[test]
    fn instructions_include_folders_and_none_option() {
        let p = provider("p1", "DeepSeek 官方", Some("https://api.deepseek.com"));
        let text = build_instructions(&[&p], &["官方".to_string(), "中转".to_string()]);
        assert!(text.contains("官方"), "got: {text}");
        assert!(text.contains("中转"), "got: {text}");
        assert!(text.contains(NONE_OPTION_ID), "got: {text}");
        assert!(text.contains("api.deepseek.com"), "got: {text}");
    }

    #[test]
    fn extract_base_url_reads_flat_and_env_shapes() {
        let flat = provider("a", "A", Some("https://api.example.com"));
        assert_eq!(
            extract_base_url(&flat).as_deref(),
            Some("https://api.example.com")
        );

        let mut nested = provider("b", "B", None);
        nested.settings_config =
            json!({ "env": { "ANTHROPIC_BASE_URL": "https://anthropic.example" } });
        assert_eq!(
            extract_base_url(&nested).as_deref(),
            Some("https://anthropic.example")
        );

        let empty = provider("c", "C", None);
        assert_eq!(extract_base_url(&empty), None);
    }

    #[test]
    fn heuristic_matches_folder_by_name_token() {
        let p = provider(
            "p1",
            "硅基流动 DeepSeek",
            Some("https://api.siliconflow.cn"),
        );
        let folders = vec!["国内中转".to_string(), "DeepSeek".to_string()];

        let result = heuristic_suggest(&[&p], &folders);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].suggested_folder.as_deref(), Some("DeepSeek"));
        assert_eq!(result[0].source, SuggestionSource::Heuristic);
    }

    #[test]
    fn heuristic_prefers_more_specific_folder() {
        // haystack 同时含「官方」和「DeepSeek」，更具体的那个得分应更高
        let p = provider("p1", "DeepSeek 官方", Some("https://api.deepseek.com"));
        let folders = vec!["官方".to_string(), "DeepSeek 官方".to_string()];

        let result = heuristic_suggest(&[&p], &folders);
        assert_eq!(
            result[0].suggested_folder.as_deref(),
            Some("DeepSeek 官方"),
            "更具体的文件夹名应该胜出"
        );
    }

    #[test]
    fn heuristic_returns_none_when_no_match() {
        let p = provider("p1", "某不知名服务", Some("https://unknown.example"));
        let result = heuristic_suggest(&[&p], &["官方".to_string(), "中转".to_string()]);
        assert_eq!(result[0].suggested_folder, None);
        assert_eq!(result[0].confidence, 0.0);
    }

    #[test]
    fn match_score_counts_all_matching_tokens() {
        // 「官方」2 字命中
        assert_eq!(match_score("deepseek 官方直连", "官方"), 2);
        // 「deepseek」8 字 + 「官方」2 字 = 10，比单词命中分高
        assert_eq!(match_score("deepseek 官方直连", "deepseek 官方"), 10);
        // 完全不命中
        assert_eq!(match_score("abc", "xyz"), 0);
        // 部分命中：只算命中的那个词，未命中的不计分
        assert_eq!(match_score("deepseek 官方直连", "deepseek 不存在"), 8);
    }

    #[tokio::test]
    async fn suggest_folders_short_circuits_without_ungrouped() {
        let result = suggest_folders(SuggestInput {
            ungrouped: Vec::new(),
            existing_folders: vec!["官方".to_string()],
            derived_folders: Vec::new(),
            config: TypeSafeConfig {
                api_key: String::new(),
                base_url: String::new(),
                model: String::new(),
            },
        })
        .await;
        assert!(result.suggestions.is_empty());
        assert!(result.degraded_reason.is_some());
    }

    #[tokio::test]
    async fn suggest_folders_degrades_when_no_candidates_at_all() {
        // 注册表空 + 从地址里也抽不出任何候选（这里的 provider 没官网地址），
        // 才真的无能为力——提示用户先建文件夹
        let p = provider("p1", "X", None);
        let result = suggest_folders(SuggestInput {
            ungrouped: vec![&p],
            existing_folders: Vec::new(),
            derived_folders: Vec::new(),
            config: TypeSafeConfig {
                api_key: "k".to_string(),
                base_url: String::new(),
                model: String::new(),
            },
        })
        .await;
        assert!(result.suggestions.is_empty());
        assert_eq!(result.source, SuggestionSource::Heuristic);
        assert!(result.degraded_reason.unwrap().contains("请先新建文件夹"));
    }

    #[tokio::test]
    async fn suggest_folders_works_from_derived_folders_on_empty_registry() {
        // 注册表是空的，但派生出一个候选名：本地启发式应能按域名关键词命中它，
        // 而不是返回"请先新建文件夹"。这是空注册表上首次使用的关键路径。
        let mut p = provider("p1", "DeepSeek 官方", None);
        p.website_url = Some("https://www.deepseek.com".to_string());
        let result = suggest_folders(SuggestInput {
            ungrouped: vec![&p],
            existing_folders: Vec::new(),
            derived_folders: vec!["deepseek.com".to_string()],
            config: TypeSafeConfig {
                api_key: String::new(), // 无 key → 走启发式
                base_url: String::new(),
                model: String::new(),
            },
        })
        .await;

        assert_eq!(result.source, SuggestionSource::Heuristic);
        assert_eq!(
            result.suggestions[0].suggested_folder.as_deref(),
            Some("deepseek.com"),
            "派生的候选名应能作为启发式的匹配目标"
        );
    }

    #[tokio::test]
    async fn suggest_folders_falls_back_to_heuristic_without_key() {
        let p = provider("p1", "DeepSeek 官方", Some("https://api.deepseek.com"));
        let result = suggest_folders(SuggestInput {
            ungrouped: vec![&p],
            existing_folders: vec!["官方".to_string()],
            derived_folders: Vec::new(),
            config: TypeSafeConfig {
                api_key: String::new(),
                base_url: String::new(),
                model: String::new(),
            },
        })
        .await;

        assert_eq!(result.source, SuggestionSource::Heuristic);
        assert_eq!(
            result.suggestions[0].suggested_folder.as_deref(),
            Some("官方")
        );
        assert!(result.degraded_reason.unwrap().contains("API Key"));
    }

    #[test]
    fn domain_root_of_extracts_registrable_domain() {
        assert_eq!(
            domain_root_of("https://www.deepseek.com").as_deref(),
            Some("deepseek.com")
        );
        assert_eq!(
            domain_root_of("https://api.deepseek.com/v1/chat").as_deref(),
            Some("deepseek.com")
        );
        assert_eq!(
            domain_root_of("integrate.api.nvidia.com").as_deref(),
            Some("nvidia.com"),
            "三段以上的域名应取后两段"
        );
        assert_eq!(
            domain_root_of("http://user:pass@api.example.io:8080/x").as_deref(),
            Some("example.io"),
            "userinfo 和端口都要剥掉"
        );
        // 大小写归一
        assert_eq!(
            domain_root_of("https://WWW.Example.COM").as_deref(),
            Some("example.com")
        );
        // 二级后缀（.co.uk 这类）：往前多取一段，否则会退化成 "co.uk"
        assert_eq!(
            domain_root_of("https://api.example.co.uk").as_deref(),
            Some("example.co.uk")
        );
    }

    #[test]
    fn domain_root_of_rejects_local_and_malformed() {
        assert_eq!(domain_root_of("http://127.0.0.1:8045"), None);
        assert_eq!(domain_root_of("http://192.168.1.10/admin"), None);
        assert_eq!(domain_root_of("http://localhost:3000"), None);
        assert_eq!(domain_root_of("http://[::1]:8080"), None);
        assert_eq!(domain_root_of(""), None);
        assert_eq!(domain_root_of("   "), None);
        assert_eq!(domain_root_of("http://"), None);
    }

    #[test]
    fn derive_folder_names_requires_two_providers_sharing_a_domain() {
        // 两个同域 + 一个本地 IP + 一个独有域名
        let a = provider("a", "A", None);
        let mut b = provider("b", "B", None);
        b.website_url = Some("https://www.nvidia.com".to_string());
        let mut c = provider("c", "C", None);
        c.website_url = Some("https://integrate.api.nvidia.com".to_string());
        let mut d = provider("d", "D", None);
        d.website_url = Some("http://127.0.0.1:4000".to_string());
        let mut e = provider("e", "E", None);
        e.website_url = Some("https://lonely.example.net".to_string());

        let derived = derive_folder_names_from_providers(&[&a, &b, &c, &d, &e]);

        assert_eq!(
            derived,
            vec!["nvidia.com".to_string()],
            "只保留 >=2 个供应商共用的域名；本地 IP 和独有域名都不建组"
        );
    }

    #[test]
    fn derive_folder_names_orders_by_group_size_desc() {
        let mut nvidia = Vec::new();
        for i in 0..3 {
            let mut p = provider(&format!("n{i}"), "N", None);
            p.website_url = Some(format!("https://site{i}.nvidia.com"));
            nvidia.push(p);
        }
        let mut or = Vec::new();
        for i in 0..2 {
            let mut p = provider(&format!("o{i}"), "O", None);
            p.website_url = Some(format!("https://site{i}.openrouter.ai"));
            or.push(p);
        }
        let all: Vec<&Provider> = nvidia.iter().chain(or.iter()).collect();

        let derived = derive_folder_names_from_providers(&all);
        assert_eq!(
            derived,
            vec!["nvidia.com".to_string(), "openrouter.ai".to_string()],
            "大组应排在前面"
        );
    }

    #[test]
    fn derive_folder_names_ignores_providers_without_website() {
        let a = provider("a", "A", None);
        let b = provider("b", "B", Some("https://127.0.0.1:4000"));
        assert!(derive_folder_names_from_providers(&[&a, &b]).is_empty());
    }
}
