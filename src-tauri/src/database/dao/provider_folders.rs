//! 供应商自定义文件夹注册表
//!
//! 存储每个 app 的用户自定义文件夹（名称、排序、展开状态）。
//! 复用 `settings` 键值表（与通用配置片段同一套机制），这样 WebDAV / S3
//! 同步整库 `db.sql` 时能白捡跨设备同步，无需改动同步协议。
//!
//! 键格式：`provider_folders_{app_type}`，值为 JSON 数组。
//!
//! 说明：条目 `id` 是注册表内部的稳定标识，仅用于前端列表 key / 未来拖拽定位；
//! 真正把供应商归到哪个文件夹，看的是 `Provider.folder`（字符串名）。
//! 名字才是业务主键，所以重命名必须连供应商一起改。

use crate::database::{lock_conn, Database};
use crate::error::AppError;
use rusqlite::{params, OptionalExtension};

/// 自定义文件夹条目（与前端 `ProviderFolder` 对齐，字段名保持 camelCase）
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderFolder {
    pub id: String,
    pub name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sort_index: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub is_expanded: Option<bool>,
}

impl Database {
    fn provider_folders_key(app_type: &str) -> String {
        format!("provider_folders_{app_type}")
    }

    /// 读取指定 app 的自定义文件夹注册表。
    /// 数据缺失或损坏时返回空列表，不向上抛错——文件夹是纯 UI 辅助数据，
    /// 不应该因为它解析失败就阻塞整个供应商列表渲染。
    pub fn get_provider_folders(&self, app_type: &str) -> Result<Vec<ProviderFolder>, AppError> {
        let raw = self.get_setting(&Self::provider_folders_key(app_type))?;
        let Some(raw) = raw else {
            return Ok(Vec::new());
        };

        match serde_json::from_str::<Vec<ProviderFolder>>(&raw) {
            Ok(folders) => Ok(folders),
            Err(e) => {
                log::warn!(
                    "[provider_folders] 注册表 JSON 解析失败，按空列表处理: app={app_type}, err={e}"
                );
                Ok(Vec::new())
            }
        }
    }

    /// 整体覆写指定 app 的文件夹注册表。
    /// 走「先读后写」的合并语义由调用方负责；这里只保证写入是原子的单次 DB 操作。
    pub fn save_provider_folders(
        &self,
        app_type: &str,
        folders: &[ProviderFolder],
    ) -> Result<(), AppError> {
        let value = serde_json::to_string(folders)
            .map_err(|e| AppError::Database(format!("序列化文件夹注册表失败: {e}")))?;
        self.set_setting(&Self::provider_folders_key(app_type), &value)
    }

    /// 批量把若干供应商的 `folder` 改成 `target`，**单事务**。
    ///
    /// 为什么不用 N 次 `save_provider`：那是 N 次串行 IPC + N 个独立事务，
    /// 中途失败会留下「一半挪完」的中间态。文件夹归组要么全成功要么全回滚。
    ///
    /// 这里直接改 `providers.meta` 里的 folder 字段，不动 `is_current` /
    /// `in_failover_queue` / `sort_index`，也不触发 live 配置重写——分组是
    /// 纯 UI 概念，改了不该影响当前生效的供应商。
    ///
    /// 返回实际被更新的行数。
    pub fn set_providers_folder(
        &self,
        app_type: &str,
        provider_ids: &[String],
        target: Option<&str>,
    ) -> Result<usize, AppError> {
        if provider_ids.is_empty() {
            return Ok(0);
        }

        // 只在这里做一次 trim/空值归一，循环里直接用
        let target = target.map(str::trim).filter(|s| !s.is_empty());

        let mut conn = lock_conn!(self.conn);
        let tx = conn
            .transaction()
            .map_err(|e| AppError::Database(e.to_string()))?;

        let mut updated = 0usize;
        for id in provider_ids {
            let Some(meta_json) = read_meta_json(&tx, app_type, id)? else {
                log::debug!("[provider_folders] 跳过不存在的供应商: id={id}, app={app_type}");
                continue;
            };

            let mut meta: crate::provider::ProviderMeta =
                serde_json::from_str(&meta_json).unwrap_or_default();

            if meta.folder.as_deref() == target {
                continue; // 已经在目标文件夹，跳过无意义写入
            }
            meta.folder = target.map(str::to_string);

            let next_json = serde_json::to_string(&meta)
                .map_err(|e| AppError::Database(format!("序列化 meta 失败: {e}")))?;
            tx.execute(
                "UPDATE providers SET meta = ?1 WHERE id = ?2 AND app_type = ?3",
                params![next_json, id, app_type],
            )
            .map_err(|e| AppError::Database(e.to_string()))?;
            updated += 1;
        }

        tx.commit().map_err(|e| AppError::Database(e.to_string()))?;
        Ok(updated)
    }

    /// 重命名文件夹：注册表 + 所有归属该文件夹的供应商，**单事务**。
    ///
    /// 旧名不在注册表里也照样改名：供应商的 `folder` 可能是从别处来的（导入的
    /// 快照、更早的版本、或用户手工在别处填过），注册表没登记不代表不能改。
    /// 只有「新名字已被注册表占用」才拒绝——那会让两个文件夹合并成一个名字。
    ///
    /// 返回被改动 folder 的供应商数量。
    pub fn rename_provider_folder(
        &self,
        app_type: &str,
        old_name: &str,
        new_name: &str,
    ) -> Result<usize, AppError> {
        let old_trimmed = old_name.trim();
        let new_trimmed = new_name.trim();
        if old_trimmed.is_empty() || new_trimmed.is_empty() || old_trimmed == new_trimmed {
            return Ok(0);
        }

        let mut conn = lock_conn!(self.conn);
        let tx = conn
            .transaction()
            .map_err(|e| AppError::Database(e.to_string()))?;

        // 注册表：在事务内直接改 settings 行，不能再走 self.get_provider_folders()
        // —— lock_conn! 锁的是非重入 Mutex，嵌套调用会死锁。
        let mut folders = read_folders_in_tx(&tx, app_type);
        if folders.iter().any(|f| f.name == new_trimmed) {
            return Ok(0); // 新名字已被占用，拒绝（否则两个文件夹会撞名）
        }

        let in_registry = folders.iter().any(|f| f.name == old_trimmed);
        if in_registry {
            rename_folder(&mut folders, old_trimmed, new_trimmed);
        }

        let updated = reassign_folder_in_tx(&tx, app_type, old_trimmed, Some(new_trimmed))?;

        // 注册表原本没有这个文件夹（孤儿分组），但确实有供应商归在它下面：
        // 把新名字补进注册表，改完名后用户才能继续重命名/解散它。
        if !in_registry && updated > 0 {
            ensure_folder_names(&mut folders, &[new_trimmed.to_string()]);
        }
        write_folders_in_tx(&tx, app_type, &folders)?;

        tx.commit().map_err(|e| AppError::Database(e.to_string()))?;
        Ok(updated)
    }

    /// 解散文件夹：从注册表移除，并把归属该文件夹的供应商移到未分组。
    /// 返回被移到未分组的供应商数量。
    pub fn delete_provider_folder(&self, app_type: &str, name: &str) -> Result<usize, AppError> {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Ok(0);
        }

        let mut conn = lock_conn!(self.conn);
        let tx = conn
            .transaction()
            .map_err(|e| AppError::Database(e.to_string()))?;

        let mut folders = read_folders_in_tx(&tx, app_type);
        let before = folders.len();
        folders.retain(|f| f.name != trimmed);
        let registry_changed = folders.len() != before;
        if registry_changed {
            write_folders_in_tx(&tx, app_type, &folders)?;
        }

        // 即使注册表里没有这条（孤儿分组），也要把归属供应商的 folder 清掉，
        // 否则界面上这个分组会一直挂着，且没法再解散一次。
        let updated = reassign_folder_in_tx(&tx, app_type, trimmed, None)?;

        tx.commit().map_err(|e| AppError::Database(e.to_string()))?;
        Ok(updated)
    }
}

// --- 事务内辅助函数 ---
//
// 这些函数只通过 `&Transaction` 读写，不碰 self.conn。目的是让
// rename/delete 能在同一个事务里既改注册表又改供应商，同时避开
// Mutex 非重入导致的死锁。

fn read_folders_in_tx(tx: &rusqlite::Transaction<'_>, app_type: &str) -> Vec<ProviderFolder> {
    let key = format!("provider_folders_{app_type}");
    let raw: Option<String> = tx
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            params![key],
            |row| row.get(0),
        )
        .optional()
        .unwrap_or(None);

    raw.and_then(|s| serde_json::from_str::<Vec<ProviderFolder>>(&s).ok())
        .unwrap_or_default()
}

fn write_folders_in_tx(
    tx: &rusqlite::Transaction<'_>,
    app_type: &str,
    folders: &[ProviderFolder],
) -> Result<(), AppError> {
    let key = format!("provider_folders_{app_type}");
    let value = serde_json::to_string(folders)
        .map_err(|e| AppError::Database(format!("序列化文件夹注册表失败: {e}")))?;
    tx.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![key, value],
    )
    .map_err(|e| AppError::Database(e.to_string()))?;
    Ok(())
}

/// 读单条供应商的 meta JSON；行不存在返回 Ok(None)。
fn read_meta_json(
    tx: &rusqlite::Transaction<'_>,
    app_type: &str,
    id: &str,
) -> Result<Option<String>, AppError> {
    tx.query_row(
        "SELECT meta FROM providers WHERE id = ?1 AND app_type = ?2",
        params![id, app_type],
        |row| row.get(0),
    )
    .optional()
    .map_err(|e| AppError::Database(e.to_string()))
}

/// 把 `folder == old_name` 的所有供应商的 folder 改成 `new_name`（None = 移到未分组）。
/// 返回被改动的行数。
fn reassign_folder_in_tx(
    tx: &rusqlite::Transaction<'_>,
    app_type: &str,
    old_name: &str,
    new_name: Option<&str>,
) -> Result<usize, AppError> {
    let ids: Vec<String> = {
        let mut stmt = tx
            .prepare("SELECT id FROM providers WHERE app_type = ?1")
            .map_err(|e| AppError::Database(e.to_string()))?;
        let rows = stmt
            .query_map(params![app_type], |row| row.get::<_, String>(0))
            .map_err(|e| AppError::Database(e.to_string()))?;
        rows.collect::<Result<_, _>>()
            .map_err(|e| AppError::Database(e.to_string()))?
    };

    let mut updated = 0usize;
    for id in ids {
        let Some(meta_json) = read_meta_json(tx, app_type, &id)? else {
            continue;
        };

        let mut meta: crate::provider::ProviderMeta =
            serde_json::from_str(&meta_json).unwrap_or_default();
        if meta.folder.as_deref().map(str::trim) != Some(old_name) {
            continue;
        }
        meta.folder = new_name.map(str::to_string);

        let next_json = serde_json::to_string(&meta)
            .map_err(|e| AppError::Database(format!("序列化 meta 失败: {e}")))?;
        tx.execute(
            "UPDATE providers SET meta = ?1 WHERE id = ?2 AND app_type = ?3",
            params![next_json, id, app_type],
        )
        .map_err(|e| AppError::Database(e.to_string()))?;
        updated += 1;
    }
    Ok(updated)
}

// --- 纯函数：注册表变换逻辑 ---

/// 把注册表按 `sort_index` 稳定排序；没有 `sort_index` 的条目排在后面，
/// 且它们之间保持写入顺序（`sort_by_key` 是稳定排序），避免用户没排序过的
/// 文件夹每次刷新都跳。
pub fn sort_folders(folders: &mut [ProviderFolder]) {
    folders.sort_by_key(|f| f.sort_index.unwrap_or(usize::MAX));
}

/// 确保注册表覆盖到 `names` 里出现的每一个文件夹名。
/// 返回是否发生了变更（调用方据此决定要不要落库，避免无意义写入）。
pub fn ensure_folder_names(folders: &mut Vec<ProviderFolder>, names: &[String]) -> bool {
    let mut changed = false;
    for name in names {
        // 供应商的 folder 字段允许首尾空格，注册表一律以 trim 后的名字为准
        let trimmed = name.trim();
        if trimmed.is_empty() {
            continue;
        }
        // 每次重新查一遍，因为上面的 push 可能刚把它加进来
        if folders.iter().any(|f| f.name == trimmed) {
            continue;
        }
        folders.push(ProviderFolder {
            // 新文件夹用「当前长度」当序号来源，重命名/解散后仍可能撞 id；
            // 但 id 只作 React key 和拖拽定位用，撞了最多是列表复用错位，
            // 不影响「哪个供应商在哪个文件夹」的正确性（那看 name）。
            id: format!("folder_{}", folders.len()),
            name: trimmed.to_string(),
            sort_index: None,
            is_expanded: Some(true),
        });
        changed = true;
    }
    changed
}

/// 重命名注册表条目，返回新名字；若新名称已被占用、旧名称不存在或参数为空，
/// 返回 `None` 表示无需变更。
pub fn rename_folder(
    folders: &mut [ProviderFolder],
    old_name: &str,
    new_name: &str,
) -> Option<String> {
    let old_trimmed = old_name.trim();
    let new_trimmed = new_name.trim();

    if old_trimmed.is_empty() || new_trimmed.is_empty() || old_trimmed == new_trimmed {
        return None;
    }
    if folders.iter().any(|f| f.name == new_trimmed) {
        return None;
    }
    if !folders.iter().any(|f| f.name == old_trimmed) {
        return None;
    }

    for folder in folders.iter_mut() {
        if folder.name == old_trimmed {
            folder.name = new_trimmed.to_string();
        }
    }
    Some(new_trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder(name: &str, sort_index: Option<usize>) -> ProviderFolder {
        ProviderFolder {
            id: format!("id_{name}"),
            name: name.to_string(),
            sort_index,
            is_expanded: Some(true),
        }
    }

    #[test]
    fn ensure_folder_names_appends_missing_and_skips_duplicates() {
        let mut folders = vec![folder("官方", None)];
        let names = vec![
            "官方".to_string(),
            "中转".to_string(),
            "  ".to_string(),
            "中转".to_string(),
        ];
        assert!(ensure_folder_names(&mut folders, &names));
        assert_eq!(
            folders.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            vec!["官方", "中转"]
        );
    }

    #[test]
    fn ensure_folder_names_no_change_when_all_present() {
        let mut folders = vec![folder("官方", None), folder("中转", None)];
        assert!(!ensure_folder_names(
            &mut folders,
            &["官方".to_string(), "中转".to_string()]
        ));
        assert_eq!(folders.len(), 2);
    }

    #[test]
    fn rename_folder_updates_entry_and_rejects_conflicts() {
        let mut folders = vec![folder("官方", None), folder("中转", None)];

        // 正常重命名
        assert_eq!(
            rename_folder(&mut folders, "官方", "主力官方"),
            Some("主力官方".to_string())
        );
        assert_eq!(folders[0].name, "主力官方");

        // 目标名已存在 → 拒绝
        assert_eq!(rename_folder(&mut folders, "主力官方", "中转"), None);
        // 旧名不存在 → 拒绝
        assert_eq!(rename_folder(&mut folders, "不存在", "新名字"), None);
        // 空名 → 拒绝
        assert_eq!(rename_folder(&mut folders, "中转", "   "), None);
        // 新旧同名 → 拒绝
        assert_eq!(rename_folder(&mut folders, "中转", "中转"), None);
    }

    #[test]
    fn sort_folders_keeps_unsorted_entries_stable_at_end() {
        let mut folders = vec![
            folder("c", Some(3)),
            folder("unsorted1", None),
            folder("a", Some(1)),
            folder("unsorted2", None),
        ];
        sort_folders(&mut folders);
        assert_eq!(
            folders.iter().map(|f| f.name.as_str()).collect::<Vec<_>>(),
            vec!["a", "c", "unsorted1", "unsorted2"]
        );
    }

    #[test]
    fn provider_folder_serializes_camel_case() {
        let f = folder("官方", Some(2));
        let json = serde_json::to_string(&f).unwrap();
        assert!(json.contains("\"sortIndex\":2"), "got: {json}");
        assert!(json.contains("\"isExpanded\":true"), "got: {json}");
        assert!(!json.contains("sort_index"), "got: {json}");
    }
}
