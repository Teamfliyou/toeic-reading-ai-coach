//! Validation et nettoyage de la réponse JSON de DeepSeek.
//!
//! Le modèle peut renvoyer du JSON entouré de balises markdown, précédé d'un préambule,
//! tronqué (max_tokens) ou de forme inattendue : on ne s'appuie jamais sur un parsing brut.

use regex::Regex;
use serde::Serialize;
use serde_json::Value;
use std::sync::OnceLock;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Explanation {
    pub diagnostic: String,
    pub resolution: String,
    pub tip: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Lesson {
    pub topic: String,
    pub title: String,
    pub rule: String,
    pub example: String,
    pub exercise: String,
    pub answer: String,
    pub tip: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ParseFailure {
    Empty,
    /// Accolade jamais refermée (réponse tronquée) ou aucun objet.
    Truncated,
    Json,
    Schema,
}

#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(clippy::large_enum_variant)] // valeur éphémère, jamais stockée en masse
pub enum Parsed {
    Ok {
        explanation: Explanation,
        lesson: Option<Lesson>,
    },
    Failed(ParseFailure),
}

/// Isole l'objet JSON : retire les balises ```json, le texte avant et après l'objet.
pub fn extract_json_text(raw: &str) -> Option<String> {
    static FENCE: OnceLock<Regex> = OnceLock::new();
    let fence = FENCE.get_or_init(|| Regex::new(r"(?i)```(?:json)?").expect("regex valide"));
    let cleaned = fence.replace_all(raw.trim(), "");
    let value = cleaned.trim();
    let start = value.find('{')?;
    let (mut depth, mut in_string, mut escaped) = (0i32, false, false);
    for (i, c) in value[start..].char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(value[start..start + i + 1].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

/// Chaîne obligatoire : rognée, non vide, tronquée à `max` caractères.
fn required(v: &Value, key: &str, max: usize) -> Option<String> {
    let s = v.get(key)?.as_str()?.trim();
    (!s.is_empty()).then(|| s.chars().take(max).collect())
}

/// Chaîne facultative : toute valeur invalide ou absente devient `""`.
fn optional(v: &Value, key: &str, max: usize) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .map(|s| s.trim().chars().take(max).collect())
        .unwrap_or_default()
}

fn lesson(v: &Value) -> Option<Lesson> {
    if !v.is_object() {
        return None;
    }
    Some(Lesson {
        topic: optional(v, "topic", 200),
        title: required(v, "title", 200)?,
        rule: required(v, "rule", 2500)?,
        example: optional(v, "example", 1200),
        exercise: required(v, "exercise", 1200)?,
        answer: required(v, "answer", 1200)?,
        tip: optional(v, "tip", 600),
    })
}

/// Analyse une réponse brute du modèle.
pub fn parse_explanation(raw: &str) -> Parsed {
    let Some(json_text) = extract_json_text(raw) else {
        return Parsed::Failed(if raw.trim().is_empty() {
            ParseFailure::Empty
        } else {
            ParseFailure::Truncated
        });
    };
    let Ok(data) = serde_json::from_str::<Value>(&json_text) else {
        return Parsed::Failed(ParseFailure::Json);
    };
    let (Some(diagnostic), Some(resolution), Some(tip)) = (
        required(&data, "diagnostic", 700),
        required(&data, "resolution", 700),
        required(&data, "tip", 500),
    ) else {
        return Parsed::Failed(ParseFailure::Schema);
    };
    Parsed::Ok {
        explanation: Explanation {
            diagnostic,
            resolution,
            tip,
        },
        lesson: data.get("lesson").and_then(lesson),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const GOOD: &str = r#"{"diagnostic":"d","resolution":"r","tip":"t",
        "lesson":{"topic":"Prépositions","title":"T","rule":"R","example":"E","exercise":"X","answer":"A","tip":"P"}}"#;

    #[test]
    fn reponse_propre() {
        let Parsed::Ok {
            explanation,
            lesson,
        } = parse_explanation(GOOD)
        else {
            panic!("attendu Ok")
        };
        assert_eq!(explanation.diagnostic, "d");
        assert_eq!(lesson.unwrap().topic, "Prépositions");
    }

    #[test]
    fn balises_et_preambule() {
        let fenced = format!("Voici :\n```json\n{GOOD}\n```\nBonne chance !");
        assert!(matches!(parse_explanation(&fenced), Parsed::Ok { .. }));
        let braces_in_string = r#"x {"diagnostic":"a } b","resolution":"r","tip":"t"} fin"#;
        let Parsed::Ok {
            explanation,
            lesson,
        } = parse_explanation(braces_in_string)
        else {
            panic!()
        };
        assert_eq!(explanation.diagnostic, "a } b");
        assert!(lesson.is_none());
    }

    #[test]
    fn echecs_classes() {
        assert_eq!(parse_explanation("  "), Parsed::Failed(ParseFailure::Empty));
        assert_eq!(
            parse_explanation("pas de json"),
            Parsed::Failed(ParseFailure::Truncated)
        );
        assert_eq!(
            parse_explanation(r#"{"diagnostic":"d","resolution":"r"#),
            Parsed::Failed(ParseFailure::Truncated)
        );
        assert_eq!(
            parse_explanation("{diagnostic: oups}"),
            Parsed::Failed(ParseFailure::Json)
        );
        assert_eq!(
            parse_explanation(r#"{"diagnostic":"d","resolution":"r"}"#),
            Parsed::Failed(ParseFailure::Schema)
        );
        assert_eq!(
            parse_explanation(r#"{"diagnostic":"d","resolution":" ","tip":"t"}"#),
            Parsed::Failed(ParseFailure::Schema)
        );
        assert_eq!(
            parse_explanation(r#"{"diagnostic":1,"resolution":"r","tip":"t"}"#),
            Parsed::Failed(ParseFailure::Schema)
        );
    }

    #[test]
    fn cours_degrade_sans_bloquer_la_correction() {
        let no_title = r#"{"diagnostic":"d","resolution":"r","tip":"t","lesson":{"rule":"R","exercise":"X","answer":"A"}}"#;
        let Parsed::Ok { lesson, .. } = parse_explanation(no_title) else {
            panic!()
        };
        assert!(lesson.is_none());
        let minimal = r#"{"diagnostic":"d","resolution":"r","tip":"t","lesson":{"title":"T","rule":"R","exercise":"X","answer":"A","example":5}}"#;
        let Parsed::Ok { lesson, .. } = parse_explanation(minimal) else {
            panic!()
        };
        let lesson = lesson.unwrap();
        assert_eq!(
            (
                lesson.example.as_str(),
                lesson.topic.as_str(),
                lesson.tip.as_str()
            ),
            ("", "", "")
        );
    }

    #[test]
    fn longueurs_bornees() {
        let long = "é".repeat(2000);
        let raw = format!(r#"{{"diagnostic":"{long}","resolution":"r","tip":"{long}"}}"#);
        let Parsed::Ok { explanation, .. } = parse_explanation(&raw) else {
            panic!()
        };
        assert_eq!(explanation.diagnostic.chars().count(), 700);
        assert_eq!(explanation.tip.chars().count(), 500);
    }
}
