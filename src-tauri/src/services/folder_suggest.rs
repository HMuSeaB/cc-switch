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

    // 没有任何已存在的文件夹时，智能分组没有意义——硬让模型起名会产出一堆
    // 用户没申请过的新分组。交给启发式也只会得到空结果，这里直接说明白。
    if input.existing_folders.is_empty() {
        return FolderSuggestResult {
            suggestions: Vec::new(),
            source: SuggestionSource::Heuristic,
            degraded_reason: Some("还没有任何文件夹，请先新建文件夹".to_string()),
            usage: None,
        };
    }

    if !input.config.is_configured() {
        return degraded(
            heuristic_suggest(&input.ungrouped, &input.existing_folders),
            "未配置 TypeSafe API Key，已使用本地启发式".to_string(),
        );
    }

    let client = TypeSafeClient::new(input.config.clone());
    match typesafe_suggest(&client, &input.ungrouped, &input.existing_folders).await {
        Ok(result) => result,
        Err(err) => {
            log::warn!("[FolderSuggest] TypeSafe 调用失败，降级到本地启发式: {err}");
            degraded(
                heuristic_suggest(&input.ungrouped, &input.existing_folders),
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
async fn typesafe_suggest(
    client: &TypeSafeClient,
    ungrouped: &[&Provider],
    existing_folders: &[String],
) -> Result<FolderSuggestResult, String> {
    // criteria：选项 id -> 该选项的含义。
    // 每个真实文件夹一个选项；`__none__` 永远在最后，语义写清楚"不属于任何一组"。
    let mut criteria: IndexMap<String, String> = IndexMap::new();
    for name in existing_folders {
        criteria.insert(name.clone(), format!("文件夹「{name}」"));
    }
    criteria.insert(
        NONE_OPTION_ID.to_string(),
        "不属于以上任何一个文件夹，保持未分组".to_string(),
    );

    let instructions = build_instructions(ungrouped, existing_folders);
    let state = build_state(ungrouped, existing_folders);

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

        suggestions.push(build_suggestion(provider, choice, existing_folders));
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
    existing_folders: &[String],
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
        Some(name) if !existing_folders.iter().any(|f| f == name) => {
            log::warn!(
                "[FolderSuggest] 模型返回了不存在的文件夹「{name}」，按未分组处理: provider={}",
                provider.id
            );
            (None, choice.confidence.min(LOW_CONFIDENCE))
        }
        _ => (suggested_folder, choice.confidence),
    };

    FolderSuggestion {
        provider_id: provider.id.clone(),
        provider_name: provider.name.clone(),
        suggested_folder,
        confidence,
        high_confidence: confidence >= HIGH_CONFIDENCE,
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

/// 组装 state：命名 JSON 字段，让模型看到结构化上下文而不只是一段话。
fn build_state(ungrouped: &[&Provider], existing_folders: &[String]) -> serde_json::Value {
    serde_json::json!({
        "project": "cc-switch",
        "goal": "把未分组的供应商归入最合适的已有文件夹",
        "context": {
            "ungrouped_count": ungrouped.len(),
            "existing_folders": existing_folders,
            "providers": ungrouped.iter().map(|p| serde_json::json!({
                "id": p.id,
                "name": p.name,
                "websiteUrl": p.website_url,
                "category": p.category,
                "baseUrl": extract_base_url(p),
                "notes": p.notes,
            })).collect::<Vec<_>>(),
        },
        "constraints": [
            "只能选择给出的文件夹名，不能发明新文件夹",
            "明显不属于任何一组的选未分组，不要勉强归类",
            "同一性质的供应商应保持分组一致",
        ],
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
    async fn suggest_folders_requires_existing_folders() {
        let p = provider("p1", "X", None);
        let result = suggest_folders(SuggestInput {
            ungrouped: vec![&p],
            existing_folders: Vec::new(),
            config: TypeSafeConfig {
                api_key: "k".to_string(),
                base_url: String::new(),
                model: String::new(),
            },
        })
        .await;
        assert!(result.suggestions.is_empty());
        assert_eq!(result.source, SuggestionSource::Heuristic);
    }

    #[tokio::test]
    async fn suggest_folders_falls_back_to_heuristic_without_key() {
        let p = provider("p1", "DeepSeek 官方", Some("https://api.deepseek.com"));
        let result = suggest_folders(SuggestInput {
            ungrouped: vec![&p],
            existing_folders: vec!["官方".to_string()],
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
}
