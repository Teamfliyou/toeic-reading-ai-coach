//! Détection de la langue du contenu d'examen (le TOEIC doit être rédigé en anglais).
//! Port de `server/bank/language.mjs`. Les `\b` sont volontairement ASCII, comme en JS.

use regex::Regex;
use std::sync::OnceLock;

fn word_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| Regex::new(r"[A-Za-zÀ-ÿ']+").expect("regex valide"))
}

fn french_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(
            r"(?i)(?-u:\b)(le|les|des|est|sont|vous|nous|pour|dans|une|avec|votre|qui|que|cette|ces|sur|mais|doit|être|sans|plus|très|aux|du)(?-u:\b)",
        )
        .expect("regex valide")
    })
}

fn english_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    R.get_or_init(|| {
        Regex::new(r"(?i)(?-u:\b)(the|and|is|are|was|were|this|that|with|because|which|should|would|has|have|not|an)(?-u:\b)")
            .expect("regex valide")
    })
}

/// Vrai si le texte est rédigé en français (mots-outils absents de l'anglais, guillemets « »).
pub fn looks_french(text: &str) -> bool {
    let words = word_re().find_iter(text).count();
    if words < 4 {
        return false;
    }
    french_re().find_iter(text).count() as f64 / words as f64 > 0.12 || text.contains(['«', '»'])
}

/// Vrai si l'explication semble rédigée en anglais (elle doit être en français).
pub fn looks_english(text: &str) -> bool {
    let words = word_re().find_iter(text).count();
    if words < 6 {
        return false;
    }
    english_re().find_iter(text).count() as f64 / words as f64 > 0.2
}

/// Vrai si aucun des textes ne semble français.
pub fn is_english_content<S: AsRef<str>>(texts: &[S]) -> bool {
    !texts.iter().any(|t| looks_french(t.as_ref()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn francais_detecte() {
        assert!(looks_french(
            "Vous devez envoyer les factures pour les clients dans une semaine ______."
        ));
        assert!(looks_french("« Hello » there my friend, how are you"));
        assert!(!looks_french(
            "All invoices must be submitted ______ the end of the month."
        ));
        assert!(!looks_french("Le plus"), "moins de 4 mots : pas de verdict");
    }

    #[test]
    fn anglais_detecte() {
        assert!(looks_english(
            "This is the correct answer because the sentence needs a preposition of time."
        ));
        assert!(!looks_english(
            "« by » indique une échéance : la facture doit arriver au plus tard à cette date."
        ));
        assert!(is_english_content(&[
            "A good sentence here",
            "Another one for the test"
        ]));
    }
}
