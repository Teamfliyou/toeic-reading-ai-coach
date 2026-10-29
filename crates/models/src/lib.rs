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
