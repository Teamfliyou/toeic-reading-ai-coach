//! Routage par `#` (identique à l'ancienne application).

#[derive(Debug, Clone, PartialEq)]
pub enum Route {
    Dashboard,
    Practice { part: u8, search: String },
    Review,
    ReviewPart(u8),
    Adaptive,
    Exam,
    Stats,
    Vocab,
    Goals,
    Lessons,
    Diagnostic,
    Listening,
    Admin,
}

pub fn parse(hash: &str) -> Route {
    let h = hash.strip_prefix('#').unwrap_or(hash);
    let (path, search) = h.split_once('?').map_or((h, ""), |(p, s)| (p, s));
    let part_of = |s: &str| match s {
        "part5" => Some(5u8),
        "part6" => Some(6),
        "part7" => Some(7),
        _ => None,
    };
    match path {
        "/lessons" => Route::Lessons,
        "/exam" => Route::Exam,
        "/stats" => Route::Stats,
        "/listening/part2" => Route::Listening,
        "/goals" => Route::Goals,
        "/vocab" => Route::Vocab,
        "/review" => Route::Review,
        "/adaptive" => Route::Adaptive,
        "/admin" => Route::Admin,
        "/diagnostic" => Route::Diagnostic,
        p => {
            if let Some(part) = p.strip_prefix("/review/").and_then(part_of) {
                Route::ReviewPart(part)
            } else if let Some(part) = p.strip_prefix("/practice/").and_then(part_of) {
                Route::Practice {
                    part,
                    search: search.to_string(),
                }
            } else {
                Route::Dashboard
            }
        }
    }
}

pub fn title(route: &Route) -> &'static str {
    match route {
        Route::Practice { .. } => "Entraînement",
        Route::Review | Route::ReviewPart(_) => "Révision",
        Route::Adaptive => "Entraînement adaptatif",
        Route::Exam => "Examen blanc",
        Route::Stats => "Statistiques",
        Route::Vocab => "Mes mots",
        Route::Goals => "Mon objectif",
        Route::Lessons => "Mes leçons",
        Route::Diagnostic => "Diagnostic",
        Route::Listening => "Listening · Partie 2",
        Route::Admin => "Administration",
        Route::Dashboard => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn routes() {
        assert_eq!(parse(""), Route::Dashboard);
        assert_eq!(parse("#/"), Route::Dashboard);
        assert_eq!(parse("#/exam"), Route::Exam);
        assert_eq!(parse("#/review/part6"), Route::ReviewPart(6));
        assert_eq!(
            parse("#/practice/part5?limit=10"),
            Route::Practice {
                part: 5,
                search: "limit=10".into()
            }
        );
        assert_eq!(parse("#/practice/part9"), Route::Dashboard);
        assert_eq!(parse("#/listening/part2"), Route::Listening);
    }
}
