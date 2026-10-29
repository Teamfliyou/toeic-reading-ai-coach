//! Les trois parties de la section Reading (port de `src/lib/parts.ts`).

pub struct PartInfo {
    pub part: u8,
    pub name: &'static str,
    pub tagline: &'static str,
    pub description: &'static str,
    pub slug: &'static str,
}

pub const PARTS: [PartInfo; 3] = [
    PartInfo {
        part: 5,
        name: "Phrases à trous",
        tagline: "Incomplete Sentences",
        description: "Grammaire et vocabulaire : choisissez le mot ou groupe de mots qui complète chaque phrase.",
        slug: "part5",
    },
    PartInfo {
        part: 6,
        name: "Textes à trous",
        tagline: "Text Completion",
        description: "Complétez un e-mail, une lettre ou un article en insérant le mot ou la phrase adapté au contexte.",
        slug: "part6",
    },
    PartInfo {
        part: 7,
        name: "Compréhension écrite",
        tagline: "Reading Comprehension",
        description: "Lisez un ou plusieurs documents (e-mails, plannings, messages croisés) et répondez aux questions.",
        slug: "part7",
    },
];

pub fn info(part: u8) -> &'static PartInfo {
    PARTS.iter().find(|p| p.part == part).unwrap_or(&PARTS[0])
}
