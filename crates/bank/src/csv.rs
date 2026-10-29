//! Lecture et écriture CSV (RFC 4180) : guillemets, retours à la ligne dans les cellules,
//! BOM UTF-8 et détection du séparateur. Port de `src/lib/bank/csv.ts`.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delimiter {
    Comma,
    Semicolon,
    Tab,
}

impl Delimiter {
    fn as_char(self) -> char {
        match self {
            Self::Comma => ',',
            Self::Semicolon => ';',
            Self::Tab => '\t',
        }
    }
}

/// Choisit le séparateur le plus fréquent de la première ligne (hors guillemets).
pub fn detect_delimiter(text: &str) -> Delimiter {
    let mut counts = [0usize; 3]; // virgule, point-virgule, tabulation
    let mut quoted = false;
    for c in text.chars().take(20_000) {
        match c {
            '"' => quoted = !quoted,
            '\n' | '\r' if !quoted => break,
            ',' if !quoted => counts[0] += 1,
            ';' if !quoted => counts[1] += 1,
            '\t' if !quoted => counts[2] += 1,
            _ => {}
        }
    }
    let mut best = 0;
    for i in 1..3 {
        if counts[i] > counts[best] {
            best = i;
        }
    }
    if counts[best] == 0 {
        return Delimiter::Comma;
    }
    [Delimiter::Comma, Delimiter::Semicolon, Delimiter::Tab][best]
}

/// Découpe un texte CSV en lignes de cellules.
pub fn parse_csv(input: &str, delimiter: Option<Delimiter>) -> Vec<Vec<String>> {
    let text = input.strip_prefix('\u{feff}').unwrap_or(input);
    let sep = delimiter
        .unwrap_or_else(|| detect_delimiter(text))
        .as_char();
    let chars: Vec<char> = text.chars().collect();
    let mut rows: Vec<Vec<String>> = vec![];
    let mut row: Vec<String> = vec![];
    let mut cell = String::new();
    let mut quoted = false;
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if quoted {
            if c == '"' {
                if chars.get(i + 1) == Some(&'"') {
                    cell.push('"');
                    i += 1;
                } else {
                    quoted = false;
                }
            } else {
                cell.push(c);
            }
        } else if c == '"' && cell.is_empty() {
            quoted = true;
        } else if c == sep {
            row.push(std::mem::take(&mut cell));
        } else if c == '\n' || c == '\r' {
            if c == '\r' && chars.get(i + 1) == Some(&'\n') {
                i += 1;
            }
            row.push(std::mem::take(&mut cell));
            rows.push(std::mem::take(&mut row));
        } else {
            cell.push(c);
        }
        i += 1;
    }
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        rows.push(row);
    }
    rows
}

/// Sérialise des lignes en CSV (guillemets si nécessaire, fins de ligne CRLF).
pub fn to_csv<S: AsRef<str>>(rows: &[Vec<S>], delimiter: Delimiter) -> String {
    let sep = delimiter.as_char();
    let escape = |value: &str| {
        if value.contains(['"', '\n', '\r']) || value.contains(sep) {
            format!("\"{}\"", value.replace('"', "\"\""))
        } else {
            value.to_string()
        }
    };
    let mut out = String::new();
    for row in rows {
        let cells: Vec<String> = row.iter().map(|c| escape(c.as_ref())).collect();
        out.push_str(&cells.join(&sep.to_string()));
        out.push_str("\r\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(rows: &[&[&str]]) -> Vec<Vec<String>> {
        rows.iter()
            .map(|r| r.iter().map(|c| c.to_string()).collect())
            .collect()
    }

    #[test]
    fn detection_du_separateur() {
        assert_eq!(detect_delimiter("a,b,c\n1;2;3;4"), Delimiter::Comma);
        assert_eq!(detect_delimiter("a;b;c"), Delimiter::Semicolon);
        assert_eq!(detect_delimiter("a\tb\tc"), Delimiter::Tab);
        assert_eq!(detect_delimiter("\"a;b;c\",d"), Delimiter::Comma);
        assert_eq!(detect_delimiter("abc"), Delimiter::Comma);
    }

    #[test]
    fn lecture_avec_guillemets_et_sauts_de_ligne() {
        let text = "\u{feff}id;texte\r\n1;\"Il dit \"\"oui\"\"\nsur deux lignes\"\r\n2;simple";
        assert_eq!(
            parse_csv(text, None),
            s(&[
                &["id", "texte"],
                &["1", "Il dit \"oui\"\nsur deux lignes"],
                &["2", "simple"]
            ])
        );
        assert_eq!(
            parse_csv("a,b\n\n,x\n", None),
            s(&[&["a", "b"], &[""], &["", "x"]])
        );
        assert!(parse_csv("", None).is_empty());
    }

    #[test]
    fn aller_retour() {
        let rows = s(&[&["a,b", "c\"d", "e\nf"], &["é", "", "z"]]);
        let csv = to_csv(&rows, Delimiter::Comma);
        assert!(csv.ends_with("\r\n"));
        assert_eq!(parse_csv(&csv, Some(Delimiter::Comma)), rows);
        let semi = to_csv(&rows, Delimiter::Semicolon);
        assert_eq!(parse_csv(&semi, None), rows);
    }
}
