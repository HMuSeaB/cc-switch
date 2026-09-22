//! TypeSafe System One (Jev) 客户端
//!
//! 封装对 TypeSafe System One API 的调用。System One 模型（旗舰为 Jev）接收
//! 自然语言 + 应用状态，返回**带概率的类型化判断**，而不是生成的文本。
//!
//! 三种推断原语（对应 `QuestionType`）：
//! - `choice`：从一组确定选项里选一个，返回概率分布
//! - `noul`：判定条件是否成立，返回 yes 概率（没有独立 confidence）
//! - `score`：沿定义维度的分级评分，返回概率加权等级
//!
//! 设计原则（来自 TypeSafe skill）：
//! - 代码掌握控制流与精确逻辑，模型只做小范围、强类型的语义判断
//! - 多个独立 question 共享同一 state 时，放在同一次请求里并行发出
//! - 用概率/置信度做阈值判断与降级，别把置信度当成"可以行动"的许可
//!
//! 契约参考：本地 JEV 项目 `src/core/jev-client.ts`。
//! `docs.typesafe.ai` 在部分网络环境不可达，所以这里不依赖其字段命名。
//!
//! 降级：未配置密钥或请求失败时返回 `None`（调用方走本地启发式），
//! 绝不让智能分组成为阻塞供应商列表渲染的硬依赖。

use serde::{Deserialize, Serialize};
use std::time::Duration;

/// 默认 API 地址
pub const DEFAULT_BASE_URL: &str = "https://api.typesafe.ai/v1";
/// 默认模型
pub const DEFAULT_MODEL: &str = "jev-latest";

/// 请求超时。智能分组是用户主动点的一次性操作，不是热路径，
/// 但也不能让用户干等——20s 拿不到就降级到本地启发式。
const REQUEST_TIMEOUT_SECS: u64 = 20;

/// 单个问题的类型
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum QuestionType {
    Choice,
    Noul,
    Score,
}

/// 一次请求里的单个问题
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Question {
    #[serde(rename = "type")]
    pub question_type: QuestionType,
    /// 要模型判断什么。用字符串即可；需要对照/示例/排除时用结构化对象更清晰。
    pub instructions: serde_json::Value,
    /// 可能的答案定义。choice 里是「选项 id -> 该选项的含义」。
    pub criteria: serde_json::Value,
}

/// 发给 System One 的请求体
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemOneRequest {
    /// 应用状态：尽量用命名 JSON 字段，别把多部分上下文塞进一个字符串
    pub state: serde_json::Value,
    pub model: String,
    /// question id -> question。id 只给代码用，不会发给模型，
    /// 所以问题本身必须自包含（完整语义写在 instructions/criteria 里）。
    pub questions: indexmap::IndexMap<String, Question>,
}

/// 单个问题的答案
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Answer {
    #[serde(rename = "type")]
    pub answer_type: String,
    /// choice 返回选中的选项 id；noul 返回布尔；score 返回等级
    pub value: Option<serde_json::Value>,
    /// choice/score 的置信度，反映概率分布的集中程度
    pub confidence: Option<f64>,
    /// choice 的完整概率分布：选项 id -> 概率
    pub probabilities: Option<serde_json::Map<String, serde_json::Value>>,
    /// noul 的 yes 概率（noul 没有独立 confidence）
    pub probability: Option<f64>,
}

/// System One 响应
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SystemOneResponse {
    pub answers: indexmap::IndexMap<String, Answer>,
    pub usage: Option<Usage>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Usage {
    #[serde(default)]
    pub prompt_tokens: u64,
    #[serde(default)]
    pub completion_tokens: u64,
    #[serde(default)]
    pub total_tokens: u64,
}

/// 一次 choice 判定的归一化结果
#[derive(Debug, Clone)]
pub struct ChoiceResult {
    pub selected: String,
    pub confidence: f64,
    /// 选项 id -> 概率。缺失时由调用方用 confidence 兜底构造。
    pub probabilities: Vec<(String, f64)>,
}

/// 调用 TypeSafe System One 所需的凭据与端点配置
#[derive(Debug, Clone)]
pub struct TypeSafeConfig {
    pub api_key: String,
    pub base_url: String,
    pub model: String,
}

impl TypeSafeConfig {
    /// 密钥为空即视为未配置
    pub fn is_configured(&self) -> bool {
        !self.api_key.trim().is_empty()
    }
}

/// TypeSafe 客户端。轻量结构体，每次调用现造即可（内部复用全局 HTTP client）。
pub struct TypeSafeClient {
    config: TypeSafeConfig,
}

impl TypeSafeClient {
    pub fn new(config: TypeSafeConfig) -> Self {
        Self { config }
    }

    /// 底层调用：POST {base_url}/systemone
    ///
    /// 复用全局 HTTP client（带全局代理配置），与 model_fetch / proxy 同一套。
    pub async fn evaluate(&self, request: &SystemOneRequest) -> Result<SystemOneResponse, String> {
        if !self.config.is_configured() {
            return Err("TypeSafe API Key 未配置".to_string());
        }

        let url = format!("{}/systemone", self.config.base_url.trim_end_matches('/'));
        let client = crate::proxy::http_client::get();

        let response = client
            .post(&url)
            .header("Authorization", format!("Bearer {}", self.config.api_key))
            .header("Content-Type", "application/json")
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
            .json(request)
            .send()
            .await
            .map_err(|e| format!("TypeSafe 请求失败: {e}"))?;

        let status = response.status();
        if !status.is_success() {
            // 错误体截断：避免把整页 HTML 错误塞进提示里
            let body = response.text().await.unwrap_or_default();
            let truncated: String = body.chars().take(512).collect();
            return Err(format!(
                "TypeSafe API 错误 [{}]: {}",
                status.as_u16(),
                truncated
            ));
        }

        response
            .json::<SystemOneResponse>()
            .await
            .map_err(|e| format!("TypeSafe 响应解析失败: {e}"))
    }

    /// 单问题便捷封装：一次请求只问一个 choice。
    ///
    /// 生产路径（智能分组）用的是 [`Self::choices`]——把 N 个供应商的判定合成
    /// 一次请求。这个单发版本留给简单场景、调试和测试。
    #[allow(dead_code)]
    pub async fn choice(
        &self,
        state: serde_json::Value,
        instructions: String,
        criteria: indexmap::IndexMap<String, String>,
    ) -> Result<ChoiceResult, String> {
        let criteria_json: serde_json::Value = criteria
            .into_iter()
            .map(|(k, v)| (k, serde_json::Value::String(v)))
            .collect::<serde_json::Map<String, serde_json::Value>>()
            .into();

        let mut questions = indexmap::IndexMap::new();
        questions.insert(
            "decision".to_string(),
            Question {
                question_type: QuestionType::Choice,
                instructions: serde_json::Value::String(instructions),
                criteria: criteria_json,
            },
        );

        let request = SystemOneRequest {
            state,
            model: self.config.model.clone(),
            questions,
        };

        let response = self.evaluate(&request).await?;
        normalize_choice_answer(response.answers.get("decision"), &[])
    }

    /// 一次请求并行问 N 个 choice。
    ///
    /// 每个 question 用 `keys[i]` 作为 id，返回值 `results` 按下标与 key 对齐。
    /// 某个 question 缺答案时该项为 `None`（不拖累同批其他项）。
    pub async fn choices(
        &self,
        state: serde_json::Value,
        instructions: String,
        keys: &[String],
        criteria: &indexmap::IndexMap<String, String>,
    ) -> Result<ChoicesResult, String> {
        if keys.is_empty() {
            return Ok(ChoicesResult {
                results: Vec::new(),
                usage: None,
            });
        }

        let criteria_json: serde_json::Value = criteria
            .iter()
            .map(|(k, v)| (k.clone(), serde_json::Value::String(v.clone())))
            .collect::<serde_json::Map<String, serde_json::Value>>()
            .into();

        let mut questions = indexmap::IndexMap::new();
        for key in keys {
            questions.insert(
                key.clone(),
                Question {
                    question_type: QuestionType::Choice,
                    instructions: serde_json::Value::String(instructions.clone()),
                    criteria: criteria_json.clone(),
                },
            );
        }

        let request = SystemOneRequest {
            state,
            model: self.config.model.clone(),
            questions,
        };

        let response = self.evaluate(&request).await?;
        let option_ids: Vec<String> = criteria.keys().cloned().collect();

        let results = keys
            .iter()
            .map(|key| normalize_choice_answer(response.answers.get(key), &option_ids).ok())
            .collect();

        Ok(ChoicesResult {
            results,
            usage: response
                .usage
                .map(|u| (u.prompt_tokens, u.completion_tokens)),
        })
    }
}

/// [`TypeSafeClient::choices`] 的返回值：逐项结果 + token 用量
#[derive(Debug, Clone)]
pub struct ChoicesResult {
    pub results: Vec<Option<ChoiceResult>>,
    /// `(prompt_tokens, completion_tokens)`；API 未返回时为 `None`
    pub usage: Option<(u64, u64)>,
}

/// 把 API 返回的 answer 归一成 [`ChoiceResult`]。
///
/// `option_ids` 是本次的合法选项集合，用于把概率分布限定在真实选项上
/// （API 偶尔会带上未定义的 key，也可能是 `__none__` 这种特殊选项）。
fn normalize_choice_answer(
    answer: Option<&Answer>,
    option_ids: &[String],
) -> Result<ChoiceResult, String> {
    let answer = answer.ok_or_else(|| "响应缺少答案".to_string())?;

    let selected = match &answer.value {
        Some(serde_json::Value::String(s)) => s.clone(),
        Some(other) => other.to_string(),
        None => return Err("choice 答案缺少 value".to_string()),
    };

    // confidence 缺失时按 JEV 客户端的老做法兜底 0.85；
    // 概率分布缺失时用 confidence 造一个单点分布。
    let confidence = answer.confidence.unwrap_or(0.85).clamp(0.0, 1.0);

    let mut probabilities: Vec<(String, f64)> = Vec::new();
    if let Some(map) = &answer.probabilities {
        for (k, v) in map {
            let p = v.as_f64().unwrap_or(0.0);
            if option_ids.is_empty() || option_ids.iter().any(|id| id == k) {
                probabilities.push((k.clone(), p.clamp(0.0, 1.0)));
            }
        }
    }
    if probabilities.is_empty() {
        probabilities.push((selected.clone(), confidence));
    }

    Ok(ChoiceResult {
        selected,
        confidence,
        probabilities,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config() -> TypeSafeConfig {
        TypeSafeConfig {
            api_key: "test-key".to_string(),
            base_url: DEFAULT_BASE_URL.to_string(),
            model: DEFAULT_MODEL.to_string(),
        }
    }

    #[test]
    fn empty_api_key_is_not_configured() {
        let mut c = config();
        c.api_key = "   ".to_string();
        assert!(!c.is_configured());
        assert!(config().is_configured());
    }

    #[test]
    fn request_serializes_question_type_as_lowercase() {
        let mut questions = indexmap::IndexMap::new();
        questions.insert(
            "q1".to_string(),
            Question {
                question_type: QuestionType::Choice,
                instructions: serde_json::Value::String("pick one".to_string()),
                criteria: serde_json::json!({ "a": "option A" }),
            },
        );
        let req = SystemOneRequest {
            state: serde_json::json!({ "project": "cc-switch" }),
            model: "jev-latest".to_string(),
            questions,
        };

        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"type\":\"choice\""), "got: {json}");
        assert!(json.contains("\"model\":\"jev-latest\""), "got: {json}");
    }

    #[test]
    fn normalize_choice_uses_confidence_fallback() {
        let answer = Answer {
            answer_type: "choice".to_string(),
            value: Some(serde_json::Value::String("folder_a".to_string())),
            confidence: None,
            probabilities: None,
            probability: None,
        };
        let result = normalize_choice_answer(Some(&answer), &[]).unwrap();
        assert_eq!(result.selected, "folder_a");
        assert_eq!(result.confidence, 0.85);
        assert_eq!(result.probabilities, vec![("folder_a".to_string(), 0.85)]);
    }

    #[test]
    fn normalize_choice_filters_probabilities_to_known_options() {
        let answer = Answer {
            answer_type: "choice".to_string(),
            value: Some(serde_json::Value::String("b".to_string())),
            confidence: Some(0.7),
            probabilities: Some(
                serde_json::json!({ "a": 0.1, "b": 0.7, "ghost": 0.2 })
                    .as_object()
                    .unwrap()
                    .clone(),
            ),
            probability: None,
        };
        let result =
            normalize_choice_answer(Some(&answer), &["a".to_string(), "b".to_string()]).unwrap();
        // ghost 不是合法选项，应被过滤掉
        assert_eq!(result.probabilities.len(), 2);
        assert!(result.probabilities.iter().all(|(k, _)| k != "ghost"));
    }

    #[test]
    fn normalize_choice_errors_when_answer_missing_or_valueless() {
        assert!(normalize_choice_answer(None, &[]).is_err());

        let no_value = Answer {
            answer_type: "choice".to_string(),
            value: None,
            confidence: Some(0.9),
            probabilities: None,
            probability: None,
        };
        assert!(normalize_choice_answer(Some(&no_value), &[]).is_err());
    }

    #[test]
    fn normalize_choice_clamps_out_of_range_confidence() {
        let answer = Answer {
            answer_type: "choice".to_string(),
            value: Some(serde_json::Value::String("x".to_string())),
            confidence: Some(4.2),
            probabilities: None,
            probability: None,
        };
        let result = normalize_choice_answer(Some(&answer), &[]).unwrap();
        assert_eq!(result.confidence, 1.0);
    }
}
