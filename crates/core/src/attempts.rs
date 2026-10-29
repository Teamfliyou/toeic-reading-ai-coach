//! Historique des tentatives : fusion et synchronisation. Port de `src/lib/attempts.ts`.

use lernoviq_models::{Attempt, AttemptMode};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

pub const MAX_LOCAL_ATTEMPTS: usize = 5000;

/// Tentatives visibles par un utilisateur : les siennes et les anonymes locales.
pub fn visible_attempts(attempts: &[Attempt], user_id: Option<&str>) -> Vec<Attempt> {
    attempts
        .iter()
        .filter(|a| a.owner.is_none() || a.owner.as_deref() == user_id)
        .cloned()
        .collect()
}

/// Tentatives à envoyer à Supabase pour `user_id` (anonymes revendiquées comprises).
pub fn pending_sync(attempts: &[Attempt], user_id: &str) -> Vec<Attempt> {
    attempts
        .iter()
        .filter(|a| !a.synced && (a.owner.is_none() || a.owner.as_deref() == Some(user_id)))
        .cloned()
        .collect()
}

/// Fusionne tentatives locales et distantes (dédoublonnées par id), récentes d'abord.
pub fn merge_attempts(local: &[Attempt], remote: &[Attempt]) -> Vec<Attempt> {
    let mut merged: Vec<Attempt> = vec![];
    let mut index: HashMap<String, usize> = HashMap::new();
    for a in remote {
        match index.get(&a.id) {
            Some(&i) => merged[i] = a.clone(),
            None => {
                index.insert(a.id.clone(), merged.len());
                merged.push(a.clone());
            }
        }
    }
    for a in local {
        match index.get(&a.id) {
            Some(&i) => {
                let owner = merged[i].owner.clone();
                merged[i] = Attempt {
                    synced: true,
                    owner,
                    ..a.clone()
                };
            }
            None => {
                index.insert(a.id.clone(), merged.len());
                merged.push(a.clone());
            }
        }
    }
    merged.sort_by_key(|a| std::cmp::Reverse(a.at));
    merged.truncate(MAX_LOCAL_ATTEMPTS);
    merged
}

/// Ligne de la table Supabase `attempts` (clés snake_case).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttemptRow {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user_id: Option<String>,
    pub question_id: String,
    pub part: u8,
    pub category: Option<String>,
    pub selected_key: String,
    pub correct: bool,
    pub time_ms: i64,
    pub mode: AttemptMode,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

pub fn to_row(a: &Attempt, user_id: &str) -> AttemptRow {
    AttemptRow {
        id: a.id.clone(),
        user_id: Some(user_id.to_string()),
        question_id: a.question_id.clone(),
        part: a.part,
        category: a.category.clone(),
        selected_key: a.selected_key.clone(),
        correct: a.correct,
        time_ms: a.time_ms,
        mode: a.mode,
        created_at: a.at,
    }
}

pub fn from_row(row: AttemptRow) -> Attempt {
    Attempt {
        id: row.id,
        question_id: row.question_id,
        part: row.part,
        category: row.category,
        selected_key: row.selected_key,
        correct: row.correct,
        time_ms: row.time_ms,
        at: row.created_at,
        mode: row.mode,
        owner: row.user_id,
        synced: true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone, Utc};

    fn att(id: &str, minutes: i64, owner: Option<&str>, synced: bool) -> Attempt {
        Attempt {
            id: id.into(),
            question_id: "q".into(),
            part: 5,
            category: Some("c".into()),
            selected_key: "A".into(),
            correct: true,
            time_ms: 1000,
            at: Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap() + Duration::minutes(minutes),
            mode: AttemptMode::Practice,
            owner: owner.map(String::from),
            synced,
        }
    }

    #[test]
    fn visibilite_et_envoi() {
        let list = vec![
            att("a", 0, None, false),
            att("b", 1, Some("u1"), false),
            att("c", 2, Some("u2"), false),
            att("d", 3, Some("u1"), true),
        ];
        let ids = |v: Vec<Attempt>| v.into_iter().map(|a| a.id).collect::<Vec<_>>();
        assert_eq!(ids(visible_attempts(&list, Some("u1"))), ["a", "b", "d"]);
        assert_eq!(ids(visible_attempts(&list, None)), ["a"]);
        assert_eq!(ids(pending_sync(&list, "u1")), ["a", "b"]);
    }

    #[test]
    fn fusion_dedoublonnee_recentes_d_abord() {
        let local = vec![att("a", 5, None, false), att("b", 1, None, false)];
        let remote = vec![att("a", 5, Some("u1"), true), att("c", 9, Some("u1"), true)];
        let merged = merge_attempts(&local, &remote);
        assert_eq!(
            merged.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(),
            ["c", "a", "b"]
        );
        let a = merged.iter().find(|a| a.id == "a").unwrap();
        assert!(a.synced);
        assert_eq!(a.owner.as_deref(), Some("u1")); // le propriétaire distant l'emporte
    }

    #[test]
    fn fusion_plafonnee() {
        let local: Vec<Attempt> = (0..5100)
            .map(|i| att(&format!("l{i}"), i, None, false))
            .collect();
        let merged = merge_attempts(&local, &[]);
        assert_eq!(merged.len(), MAX_LOCAL_ATTEMPTS);
        assert_eq!(merged[0].id, "l5099");
    }

    #[test]
    fn lignes_supabase() {
        let a = att("a", 0, None, false);
        let row = to_row(&a, "u1");
        let json = serde_json::to_string(&row).unwrap();
        assert!(json.contains("\"question_id\"") && json.contains("\"mode\":\"practice\""));
        let back = from_row(row);
        assert_eq!((back.owner.as_deref(), back.synced), (Some("u1"), true));
    }
}
