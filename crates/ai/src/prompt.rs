//! Prompts du coach d'explication. Port de `server/explain.mjs`.

pub const SYSTEM_PROMPT: &str = r#"Tu es un professeur d'anglais expert du TOEIC, pédagogue, précis et bienveillant. Tu expliques les erreurs de grammaire et de vocabulaire de la partie Reading (compréhension écrite) du nouveau TOEIC.

Règles strictes :
- Rédige les explications en français, mais tout contenu d'exercice (exemples, mini-question et ses choix A à D) doit être écrit en anglais, jamais en français.
- Les champs diagnostic, resolution et tip font chacun au maximum 50 mots. Le cours est plus détaillé.
- Analyse le thème précis de la question (temps, prépositions, vocabulaire, connecteurs, compréhension...).
- Explique une règle correcte, adapte-la à la faute précise et propose une mini-question inédite.
- Ne répète pas la question, va droit au but.
- Réponds UNIQUEMENT avec un objet JSON valide, sans texte avant ni après, sans bloc de code.

Le format JSON attendu est exactement :
{
  "diagnostic": "Pourquoi la réponse choisie par l'utilisateur est fausse",
  "resolution": "Pourquoi la bonne réponse est correcte",
  "tip": "Une astuce courte pour repérer ce piège récurrent au TOEIC",
  "lesson": {
    "topic": "Thème grammatical ou compétence précise, en français",
    "title": "Titre clair du cours",
    "rule": "Règle pédagogique en français, détaillée en 80 à 130 mots",
    "example": "Un nouvel exemple anglais avec son explication française",
    "exercise": "Une mini-question originale rédigée en anglais avec quatre choix A, B, C et D en anglais",
    "answer": "Bonne lettre, réponse et justification pédagogique",
    "tip": "Méthode concrète pour éviter cette erreur au TOEIC"
  }
}"#;

pub const RETRY_NOTE: &str = "Ta réponse précédente était invalide ou tronquée. Réponds de nouveau par un objet JSON COMPLET et COMPACT : \"diagnostic\", \"resolution\" et \"tip\" (30 mots maximum chacun) et \"lesson\": null.";

/// Contexte (document) envoyé à l'IA : borné pour maîtriser le coût.
pub const MAX_CONTEXT_CHARS: usize = 4500;

pub struct PromptQuestion<'a> {
    pub part: u8,
    pub prompt: &'a str,
    pub options: &'a [(char, String)],
    pub correct_key: char,
    pub context: &'a str,
}

pub fn build_user_prompt(q: &PromptQuestion, selected_key: char) -> String {
    let options = q
        .options
        .iter()
        .map(|(k, t)| format!("{k}. {t}"))
        .collect::<Vec<_>>()
        .join("\n");
    let context: String = q.context.chars().take(MAX_CONTEXT_CHARS).collect();
    [
        format!("Partie {} du TOEIC.", q.part),
        if context.is_empty() {
            String::new()
        } else {
            format!("Document à analyser :\n{context}")
        },
        String::new(),
        format!("Énoncé : {}", q.prompt),
        String::new(),
        "Choix proposés :".to_string(),
        options,
        String::new(),
        format!("Réponse choisie par l'élève : {selected_key}"),
        format!("Bonne réponse : {}", q.correct_key),
        String::new(),
        "Explique l'erreur dans le format JSON demandé.".to_string(),
    ]
    .join("\n")
}

/// Met en forme les documents d'un passage (un bloc par document, un paragraphe par ligne).
pub fn render_documents(docs: &[(String, Vec<String>)]) -> String {
    docs.iter()
        .map(|(title, body)| format!("{title}\n{}", body.join("\n")))
        .collect::<Vec<_>>()
        .join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> Vec<(char, String)> {
        vec![
            ('A', "by".into()),
            ('B', "until".into()),
            ('C', "since".into()),
            ('D', "during".into()),
        ]
    }

    #[test]
    fn prompt_sans_document() {
        let o = opts();
        let q = PromptQuestion {
            part: 5,
            prompt: "Pay ______ Friday.",
            options: &o,
            correct_key: 'A',
            context: "",
        };
        let p = build_user_prompt(&q, 'B');
        assert_eq!(
            p,
            "Partie 5 du TOEIC.\n\n\nÉnoncé : Pay ______ Friday.\n\nChoix proposés :\nA. by\nB. until\nC. since\nD. during\n\nRéponse choisie par l'élève : B\nBonne réponse : A\n\nExplique l'erreur dans le format JSON demandé."
        );
    }

    #[test]
    fn contexte_borne_et_documents() {
        let o = opts();
        let ctx = "x".repeat(10_000);
        let q = PromptQuestion {
            part: 7,
            prompt: "Why?",
            options: &o,
            correct_key: 'C',
            context: &ctx,
        };
        let p = build_user_prompt(&q, 'A');
        assert!(p.contains(&format!(
            "Document à analyser :\n{}",
            "x".repeat(MAX_CONTEXT_CHARS)
        )));
        assert!(!p.contains(&"x".repeat(MAX_CONTEXT_CHARS + 1)));
        let docs = vec![
            (
                "Memo".to_string(),
                vec!["Line 1".to_string(), "Line 2".to_string()],
            ),
            ("Note".to_string(), vec![]),
        ];
        assert_eq!(render_documents(&docs), "Memo\nLine 1\nLine 2\n\nNote\n");
    }

    #[test]
    fn consignes_systeme() {
        assert!(
            SYSTEM_PROMPT.contains("au maximum 50 mots. Le cours est plus détaillé.\n- Analyse")
        );
        assert!(SYSTEM_PROMPT.ends_with('}'));
    }
}
