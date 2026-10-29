pub mod adaptive;
pub mod dashboard;
pub mod diagnostic;
pub mod exam;
pub mod goals;
pub mod lessons;
pub mod practice;
pub mod review;
pub mod stats;
pub mod unavailable;
pub mod vocab;

/// Jour de la semaine et mois en français, pour les dates affichées.
pub fn fr_date(d: chrono::NaiveDate) -> String {
    use chrono::Datelike;
    const DAYS: [&str; 7] = [
        "lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche",
    ];
    const MONTHS: [&str; 12] = [
        "janvier",
        "février",
        "mars",
        "avril",
        "mai",
        "juin",
        "juillet",
        "août",
        "septembre",
        "octobre",
        "novembre",
        "décembre",
    ];
    format!(
        "{} {} {}",
        DAYS[d.weekday().num_days_from_monday() as usize],
        d.day(),
        MONTHS[d.month0() as usize]
    )
}
