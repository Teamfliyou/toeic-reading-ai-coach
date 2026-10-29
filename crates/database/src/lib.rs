//! Persistance locale SQLite (SQLx) : migrations versionnées, tentatives, cartes de révision,
//! vocabulaire, objectifs, historique d'examens et paramètres.
//!
//! Les règles de fusion reprennent celles de `lernoviq-core` : la version la plus récente
//! (`updated_at`) gagne ; une tentative déjà connue n'est jamais dupliquée.

use chrono::{DateTime, NaiveDate, Utc};
use lernoviq_core::attempts::MAX_LOCAL_ATTEMPTS;
use lernoviq_core::goals::{ExamRecord, Goals};
use lernoviq_core::srs::ReviewCard;
use lernoviq_core::vocab::VocabWord;
use lernoviq_models::{Attempt, AttemptMode};
use serde::Deserialize;
use sqlx::sqlite::{SqliteConnectOptions, SqliteJournalMode, SqlitePoolOptions, SqliteRow};
use sqlx::{Row, SqlitePool};
use std::path::Path;
use std::str::FromStr;

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("erreur de base de données : {0}")]
    Sql(#[from] sqlx::Error),
    #[error("migration impossible : {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
    #[error("données invalides : {0}")]
    Data(String),
    #[error("JSON invalide : {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, DbError>;

#[derive(Clone)]
pub struct Db {
    pool: SqlitePool,
}

fn mode_str(m: AttemptMode) -> &'static str {
    match m {
        AttemptMode::Practice => "practice",
        AttemptMode::Review => "review",
        AttemptMode::Exam => "exam",
        AttemptMode::Diagnostic => "diagnostic",
        AttemptMode::Listening => "listening",
    }
}

fn parse_mode(s: &str) -> Result<AttemptMode> {
    Ok(match s {
        "practice" => AttemptMode::Practice,
        "review" => AttemptMode::Review,
        "exam" => AttemptMode::Exam,
        "diagnostic" => AttemptMode::Diagnostic,
        "listening" => AttemptMode::Listening,
        other => {
            return Err(DbError::Data(format!(
                "mode de tentative inconnu : {other}"
            )))
        }
    })
}

impl Db {
    /// Ouvre (ou crée) la base du fichier `path` et applique les migrations en attente.
    pub async fn open(path: &Path) -> Result<Self> {
        let options = SqliteConnectOptions::from_str(&format!("sqlite://{}", path.display()))?
            .create_if_missing(true)
            .journal_mode(SqliteJournalMode::Wal)
            .foreign_keys(true);
        Self::connect(options, 4).await
    }

    /// Base en mémoire (tests).
    pub async fn open_memory() -> Result<Self> {
        Self::connect(SqliteConnectOptions::from_str("sqlite::memory:")?, 1).await
    }

    async fn connect(options: SqliteConnectOptions, max: u32) -> Result<Self> {
        let pool = SqlitePoolOptions::new()
            .max_connections(max)
            .connect_with(options)
            .await?;
        sqlx::migrate!("./migrations").run(&pool).await?;
        Ok(Self { pool })
    }

    // --- Tentatives ---

    /// Insère les tentatives ; une tentative connue garde son contenu, `synced` ne régresse jamais.
    pub async fn upsert_attempts(&self, attempts: &[Attempt]) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        for a in attempts {
            sqlx::query(
                "INSERT INTO attempts (id, question_id, part, category, selected_key, correct, time_ms, at, mode, owner, synced)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
                 ON CONFLICT(id) DO UPDATE SET
                    synced = MAX(attempts.synced, excluded.synced),
                    owner = COALESCE(attempts.owner, excluded.owner)",
            )
            .bind(&a.id)
            .bind(&a.question_id)
            .bind(i64::from(a.part))
            .bind(&a.category)
            .bind(&a.selected_key)
            .bind(a.correct)
            .bind(a.time_ms)
            .bind(a.at)
            .bind(mode_str(a.mode))
            .bind(&a.owner)
            .bind(a.synced)
            .execute(&mut *tx)
            .await?;
        }
        sqlx::query(
            "DELETE FROM attempts WHERE id NOT IN (SELECT id FROM attempts ORDER BY at DESC LIMIT ?1)",
        )
        .bind(MAX_LOCAL_ATTEMPTS as i64)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Tentatives, récentes d'abord.
    pub async fn list_attempts(&self) -> Result<Vec<Attempt>> {
        let rows = sqlx::query("SELECT * FROM attempts ORDER BY at DESC")
            .fetch_all(&self.pool)
            .await?;
        rows.iter().map(attempt_from_row).collect()
    }

    pub async fn mark_synced(&self, ids: &[String]) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        for id in ids {
            sqlx::query("UPDATE attempts SET synced = 1 WHERE id = ?1")
                .bind(id)
                .execute(&mut *tx)
                .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    // --- Cartes de révision ---

    pub async fn upsert_cards(&self, cards: &[ReviewCard]) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        for c in cards {
            sqlx::query(
                "INSERT INTO review_cards (question_id, part, box, due, mastered, lapses, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT(question_id) DO UPDATE SET
                    part = excluded.part, box = excluded.box, due = excluded.due,
                    mastered = excluded.mastered, lapses = excluded.lapses, updated_at = excluded.updated_at
                 WHERE excluded.updated_at > review_cards.updated_at",
            )
            .bind(&c.question_id)
            .bind(i64::from(c.part))
            .bind(i64::from(c.box_))
            .bind(c.due)
            .bind(c.mastered)
            .bind(i64::from(c.lapses))
            .bind(c.updated_at)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    pub async fn list_cards(&self) -> Result<Vec<ReviewCard>> {
        let rows = sqlx::query("SELECT * FROM review_cards ORDER BY updated_at DESC")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .iter()
            .map(|r| ReviewCard {
                question_id: r.get("question_id"),
                part: r.get::<i64, _>("part") as u8,
                box_: r.get::<i64, _>("box") as u8,
                due: r.get("due"),
                mastered: r.get("mastered"),
                lapses: r.get::<i64, _>("lapses") as u32,
                updated_at: r.get("updated_at"),
            })
            .collect())
    }

    // --- Vocabulaire ---

    pub async fn upsert_words(&self, words: &[VocabWord]) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        for w in words {
            sqlx::query(
                "INSERT INTO vocab_words (id, term, meaning, example, source_question_id, created_at, updated_at, box, due, mastered, lapses, deleted)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
                 ON CONFLICT(id) DO UPDATE SET
                    term = excluded.term, meaning = excluded.meaning, example = excluded.example,
                    source_question_id = excluded.source_question_id, updated_at = excluded.updated_at,
                    box = excluded.box, due = excluded.due, mastered = excluded.mastered,
                    lapses = excluded.lapses, deleted = excluded.deleted
                 WHERE excluded.updated_at > vocab_words.updated_at",
            )
            .bind(&w.id)
            .bind(&w.term)
            .bind(&w.meaning)
            .bind(&w.example)
            .bind(&w.source_question_id)
            .bind(w.created_at)
            .bind(w.updated_at)
            .bind(i64::from(w.box_))
            .bind(w.due)
            .bind(w.mastered)
            .bind(i64::from(w.lapses))
            .bind(w.deleted)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }

    /// Tous les mots, suppressions logiques comprises (elles se synchronisent).
    pub async fn list_words(&self) -> Result<Vec<VocabWord>> {
        let rows = sqlx::query("SELECT * FROM vocab_words ORDER BY created_at")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .iter()
            .map(|r| VocabWord {
                id: r.get("id"),
                term: r.get("term"),
                meaning: r.get("meaning"),
                example: r.get("example"),
                source_question_id: r.get("source_question_id"),
                created_at: r.get("created_at"),
                updated_at: r.get("updated_at"),
                box_: r.get::<i64, _>("box") as u8,
                due: r.get("due"),
                mastered: r.get("mastered"),
                lapses: r.get::<i64, _>("lapses") as u32,
                deleted: r.get("deleted"),
            })
            .collect())
    }

    // --- Objectifs ---

    pub async fn get_goals(&self) -> Result<Goals> {
        let row = sqlx::query("SELECT * FROM goals WHERE id = 1")
            .fetch_optional(&self.pool)
            .await?;
        Ok(match row {
            None => Goals::default(),
            Some(r) => Goals {
                exam_date: r
                    .get::<Option<String>, _>("exam_date")
                    .map(|d| NaiveDate::parse_from_str(&d, "%Y-%m-%d"))
                    .transpose()
                    .map_err(|e| DbError::Data(e.to_string()))?,
                target_score: r.get::<Option<i64>, _>("target_score").map(|v| v as u32),
                daily_goal: r.get::<i64, _>("daily_goal") as u32,
                updated_at: r.get("updated_at"),
            },
        })
    }

    /// Enregistre les objectifs si ce jeu est plus récent que celui déjà stocké.
    pub async fn set_goals(&self, g: &Goals) -> Result<()> {
        sqlx::query(
            "INSERT INTO goals (id, exam_date, target_score, daily_goal, updated_at) VALUES (1, ?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET exam_date = excluded.exam_date, target_score = excluded.target_score,
                daily_goal = excluded.daily_goal, updated_at = excluded.updated_at
             WHERE excluded.updated_at > goals.updated_at",
        )
        .bind(g.exam_date.map(|d| d.format("%Y-%m-%d").to_string()))
        .bind(g.target_score.map(i64::from))
        .bind(i64::from(g.daily_goal))
        .bind(g.updated_at)
        .execute(&self.pool)
        .await?;
        Ok(())
    }

    // --- Examens ---

    pub async fn add_exam(&self, e: &ExamRecord) -> Result<()> {
        sqlx::query("INSERT OR IGNORE INTO exam_history (at, score, correct, total) VALUES (?1, ?2, ?3, ?4)")
            .bind(e.at)
            .bind(i64::from(e.score))
            .bind(i64::from(e.correct))
            .bind(i64::from(e.total))
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn list_exams(&self) -> Result<Vec<ExamRecord>> {
        let rows = sqlx::query("SELECT * FROM exam_history ORDER BY at DESC")
            .fetch_all(&self.pool)
            .await?;
        Ok(rows
            .iter()
            .map(|r| ExamRecord {
                at: r.get("at"),
                score: r.get::<i64, _>("score") as u32,
                correct: r.get::<i64, _>("correct") as u32,
                total: r.get::<i64, _>("total") as u32,
            })
            .collect())
    }

    // --- Paramètres ---

    pub async fn get_setting(&self, key: &str) -> Result<Option<String>> {
        Ok(sqlx::query("SELECT value FROM settings WHERE key = ?1")
            .bind(key)
            .fetch_optional(&self.pool)
            .await?
            .map(|r| r.get("value")))
    }

    pub async fn set_setting(&self, key: &str, value: &str) -> Result<()> {
        sqlx::query("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .bind(key)
            .bind(value)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    // --- Import de l'ancienne version web ---

    /// Importe un export JSON de l'ancienne application (clés camelCase, identiques à celles
    /// de `localStorage`). Idempotent : réimporter le même fichier ne crée aucun doublon.
    pub async fn import_legacy(&self, json: &str) -> Result<ImportReport> {
        let export: LegacyExport = serde_json::from_str(json)?;
        let report = ImportReport {
            attempts: export.attempts.len(),
            cards: export.cards.len(),
            words: export.vocab.len(),
            exams: export.exams.len(),
            goals: export.goals.is_some(),
        };
        self.upsert_attempts(&export.attempts).await?;
        self.upsert_cards(&export.cards).await?;
        self.upsert_words(&export.vocab).await?;
        for e in &export.exams {
            self.add_exam(e).await?;
        }
        if let Some(g) = &export.goals {
            self.set_goals(g).await?;
        }
        Ok(report)
    }

    /// Copie cohérente de la base dans `dest` (sauvegarde avant mise à jour ou migration).
    pub async fn backup_to(&self, dest: &Path) -> Result<()> {
        if dest.exists() {
            return Err(DbError::Data(format!("{} existe déjà", dest.display())));
        }
        sqlx::query("VACUUM INTO ?1")
            .bind(dest.display().to_string())
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn close(&self) {
        self.pool.close().await;
    }
}

fn attempt_from_row(r: &SqliteRow) -> Result<Attempt> {
    Ok(Attempt {
        id: r.get("id"),
        question_id: r.get("question_id"),
        part: r.get::<i64, _>("part") as u8,
        category: r.get("category"),
        selected_key: r.get("selected_key"),
        correct: r.get("correct"),
        time_ms: r.get("time_ms"),
        at: r.get::<DateTime<Utc>, _>("at"),
        mode: parse_mode(&r.get::<String, _>("mode"))?,
        owner: r.get("owner"),
        synced: r.get("synced"),
    })
}

#[derive(Debug, Default, Deserialize)]
struct LegacyExport {
    #[serde(default)]
    attempts: Vec<Attempt>,
    #[serde(default)]
    cards: Vec<ReviewCard>,
    #[serde(default)]
    vocab: Vec<VocabWord>,
    #[serde(default)]
    exams: Vec<ExamRecord>,
    goals: Option<Goals>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ImportReport {
    pub attempts: usize,
    pub cards: usize,
    pub words: usize,
    pub exams: usize,
    pub goals: bool,
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::{Duration, TimeZone};
    use lernoviq_core::srs::{apply_answer, AnswerEvent};
    use lernoviq_core::vocab::{create_word, WordInput};

    fn t(minutes: i64) -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 1, 1, 0, 0, 0).unwrap() + Duration::minutes(minutes)
    }
    fn att(id: &str, minutes: i64, owner: Option<&str>, synced: bool) -> Attempt {
        Attempt {
            id: id.into(),
            question_id: "q1".into(),
            part: 5,
            category: Some("prepositions".into()),
            selected_key: "A".into(),
            correct: true,
            time_ms: 1200,
            at: t(minutes),
            mode: AttemptMode::Practice,
            owner: owner.map(String::from),
            synced,
        }
    }

    #[tokio::test]
    async fn tentatives_sans_doublon_et_synced_monotone() {
        let db = Db::open_memory().await.unwrap();
        db.upsert_attempts(&[att("a", 1, None, false), att("b", 2, None, false)])
            .await
            .unwrap();
        db.upsert_attempts(&[att("a", 1, Some("u1"), true), att("a", 1, None, false)])
            .await
            .unwrap();
        let list = db.list_attempts().await.unwrap();
        assert_eq!(
            list.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(),
            ["b", "a"]
        );
        let a = list.iter().find(|a| a.id == "a").unwrap();
        assert!(a.synced, "synced ne régresse jamais");
        assert_eq!(a.owner.as_deref(), Some("u1"));
        db.mark_synced(&["b".to_string()]).await.unwrap();
        assert!(db.list_attempts().await.unwrap().iter().all(|a| a.synced));
    }

    #[tokio::test]
    async fn plafond_de_tentatives() {
        let db = Db::open_memory().await.unwrap();
        let many: Vec<Attempt> = (0..5050)
            .map(|i| att(&format!("x{i}"), i, None, false))
            .collect();
        db.upsert_attempts(&many).await.unwrap();
        let list = db.list_attempts().await.unwrap();
        assert_eq!(list.len(), MAX_LOCAL_ATTEMPTS);
        assert_eq!(list[0].id, "x5049");
    }

    #[tokio::test]
    async fn cartes_la_plus_recente_gagne() {
        let db = Db::open_memory().await.unwrap();
        let ev = AnswerEvent {
            question_id: "q".into(),
            part: 5,
            correct: false,
        };
        let old = apply_answer(&[], &ev, t(0));
        let newer = apply_answer(&old, &ev, t(10));
        db.upsert_cards(&newer).await.unwrap();
        db.upsert_cards(&old).await.unwrap(); // plus ancienne : ignorée
        let cards = db.list_cards().await.unwrap();
        assert_eq!(
            (cards.len(), cards[0].lapses, cards[0].updated_at),
            (1, 2, t(10))
        );
    }

    #[tokio::test]
    async fn vocabulaire_et_suppression_logique() {
        let db = Db::open_memory().await.unwrap();
        let w = create_word(
            WordInput {
                term: "deadline".into(),
                meaning: "échéance".into(),
                ..Default::default()
            },
            "w1".into(),
            t(0),
        );
        db.upsert_words(std::slice::from_ref(&w)).await.unwrap();
        let gone = lernoviq_core::vocab::mark_deleted(&w, t(5));
        db.upsert_words(&[gone]).await.unwrap();
        db.upsert_words(&[w]).await.unwrap(); // ancienne version : ignorée
        let words = db.list_words().await.unwrap();
        assert_eq!(words.len(), 1);
        assert!(words[0].deleted);
    }

    #[tokio::test]
    async fn objectifs_examens_parametres() {
        let db = Db::open_memory().await.unwrap();
        assert_eq!(db.get_goals().await.unwrap(), Goals::default());
        let g = Goals {
            exam_date: NaiveDate::from_ymd_opt(2026, 12, 15),
            target_score: Some(400),
            daily_goal: 15,
            updated_at: t(1),
        };
        db.set_goals(&g).await.unwrap();
        db.set_goals(&Goals {
            daily_goal: 99,
            updated_at: t(0),
            ..g.clone()
        })
        .await
        .unwrap();
        assert_eq!(db.get_goals().await.unwrap(), g);

        let e = ExamRecord {
            at: t(3),
            score: 340,
            correct: 70,
            total: 100,
        };
        db.add_exam(&e).await.unwrap();
        db.add_exam(&e).await.unwrap();
        assert_eq!(db.list_exams().await.unwrap(), vec![e]);

        assert_eq!(db.get_setting("theme").await.unwrap(), None);
        db.set_setting("theme", "dark").await.unwrap();
        db.set_setting("theme", "glass").await.unwrap();
        assert_eq!(
            db.get_setting("theme").await.unwrap().as_deref(),
            Some("glass")
        );
    }

    #[tokio::test]
    async fn import_ancien_format_idempotent() {
        let db = Db::open_memory().await.unwrap();
        let json = r#"{
          "attempts": [{"id":"a1","questionId":"q1","part":5,"category":"prepositions","selectedKey":"B","correct":false,
                        "timeMs":3000,"at":"2026-10-01T10:00:00.000Z","mode":"practice","owner":null,"synced":false}],
          "cards": [{"questionId":"q1","part":5,"box":1,"due":"2026-10-01T10:00:00.000Z","mastered":false,"lapses":1,"updatedAt":"2026-10-01T10:00:00.000Z"}],
          "vocab": [],
          "exams": [{"at":"2026-10-02T10:00:00.000Z","score":300,"correct":60,"total":100}],
          "goals": {"examDate":"2026-12-15","targetScore":400,"dailyGoal":12,"updatedAt":"2026-10-01T00:00:00.000Z"}
        }"#;
        let report = db.import_legacy(json).await.unwrap();
        assert_eq!(
            report,
            ImportReport {
                attempts: 1,
                cards: 1,
                words: 0,
                exams: 1,
                goals: true
            }
        );
        db.import_legacy(json).await.unwrap();
        assert_eq!(db.list_attempts().await.unwrap().len(), 1);
        assert_eq!(db.list_cards().await.unwrap().len(), 1);
        assert_eq!(db.list_exams().await.unwrap().len(), 1);
        assert_eq!(db.get_goals().await.unwrap().daily_goal, 12);
        assert!(db.import_legacy("pas du json").await.is_err());
    }

    #[tokio::test]
    async fn persistance_fichier_migrations_et_sauvegarde() {
        let dir = std::env::temp_dir().join(format!("lernoviq-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("lernoviq.db");
        let _ = std::fs::remove_file(&path);
        {
            let db = Db::open(&path).await.unwrap();
            db.upsert_attempts(&[att("a", 1, None, false)])
                .await
                .unwrap();
            db.close().await;
        }
        // Réouverture : migrations idempotentes, données conservées (cas d'une mise à jour de l'application).
        let db = Db::open(&path).await.unwrap();
        assert_eq!(db.list_attempts().await.unwrap().len(), 1);
        let backup = dir.join("backup.db");
        let _ = std::fs::remove_file(&backup);
        db.backup_to(&backup).await.unwrap();
        assert!(db.backup_to(&backup).await.is_err());
        db.close().await;
        let restored = Db::open(&backup).await.unwrap();
        assert_eq!(restored.list_attempts().await.unwrap().len(), 1);
        restored.close().await;
        let _ = std::fs::remove_dir_all(&dir);
    }
}
