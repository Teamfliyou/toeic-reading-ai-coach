//! Modèles de données partagés (équivalent de `src/lib/types.ts`).
//! Le JSON reste en camelCase pour rester compatible avec les données existantes.

use serde::{Deserialize, Serialize};

/// Référence minimale d'une question pour composer et corriger un examen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExamQuestionRef {
    pub id: String,
    pub part: u8,
    pub order_index: u32,
    pub correct_key: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttemptMode {
    Practice,
    Review,
    Exam,
    Diagnostic,
    Listening,
}

/// Tentative de réponse (équivalent de `Attempt` dans `src/lib/attempts.ts`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Attempt {
    pub id: String,
    pub question_id: String,
    /// 2 = Listening Part 2 ; 5, 6, 7 = Reading.
    pub part: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    pub selected_key: String,
    pub correct: bool,
    pub time_ms: i64,
    pub at: chrono::DateTime<chrono::Utc>,
    pub mode: AttemptMode,
    pub owner: Option<String>,
    pub synced: bool,
}

/// Au-delà, un temps est considéré comme une pause (onglet laissé ouvert).
pub const MAX_COUNTED_TIME_MS: i64 = 5 * 60_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OptionKey {
    A,
    B,
    C,
    D,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionOption {
    pub key: OptionKey,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PassageDocument {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub body: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Passage {
    pub id: String,
    pub part: u8,
    pub title: String,
    pub documents: Vec<PassageDocument>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Question {
    pub id: String,
    pub part: u8,
    pub passage_id: Option<String>,
    pub order_index: u32,
    pub prompt: String,
    pub options: Vec<QuestionOption>,
    pub correct_key: OptionKey,
    /// 1 (facile), 2 (intermédiaire), 3 (avancée).
    pub difficulty: u8,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub explanation: Option<String>,
}
