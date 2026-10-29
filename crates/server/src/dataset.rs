//! Jeu de questions embarqué (`data/questions.json`) : les questions du jeu local n'ont pas
//! besoin de Supabase.

use crate::backend::render_documents_json;
use lernoviq_ai::ExplainQuestion;
use serde_json::Value;
use std::sync::OnceLock;

fn dataset() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!("../../../data/questions.json"))
            .expect("data/questions.json valide")
    })
}

pub fn find_local(id: &str) -> Option<ExplainQuestion> {
    let data = dataset();
    let q = data["questions"]
        .as_array()?
        .iter()
        .find(|q| q["id"] == id)?;
    let context = q["passageId"]
        .as_str()
        .and_then(|pid| data["passages"].as_array()?.iter().find(|p| p["id"] == pid))
        .map(|p| render_documents_json(&p["documents"]))
        .unwrap_or_default();
    Some(ExplainQuestion {
        part: q["part"].as_u64()? as u8,
        prompt: q["prompt"].as_str()?.to_string(),
        options: q["options"]
            .as_array()?
            .iter()
            .filter_map(|o| {
                Some((
                    o["key"].as_str()?.chars().next()?,
                    o["text"].as_str()?.to_string(),
                ))
            })
            .collect(),
        correct_key: q["correctKey"].as_str()?.chars().next()?,
        context,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn question_sans_document_et_avec_document() {
        let p5 = find_local("q5-01").expect("q5-01 existe");
        assert_eq!(p5.part, 5);
        assert_eq!(p5.options.len(), 4);
        assert!(p5.context.is_empty());
        let data = dataset();
        let p6 = data["questions"]
            .as_array()
            .unwrap()
            .iter()
            .find(|q| q["part"] == 6)
            .unwrap();
        let loaded = find_local(p6["id"].as_str().unwrap()).unwrap();
        assert!(loaded.context.contains("Health and Safety") || !loaded.context.is_empty());
        assert!(find_local("inexistante").is_none());
    }
}
