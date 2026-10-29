//! État partagé de l'application : données d'apprentissage persistées (SQLite via Tauri,
//! `localStorage` dans un navigateur) et réglages. Toute la logique vient de `lernoviq-core`.

use crate::bridge;
use chrono::{DateTime, Utc};
use dioxus::prelude::*;
use lernoviq_core::attempts::MAX_LOCAL_ATTEMPTS;
use lernoviq_core::goals::{ExamRecord, Goals};
use lernoviq_core::srs::{apply_answer, AnswerEvent, ReviewCard};
use lernoviq_core::vocab::VocabWord;
use lernoviq_models::{Attempt, AttemptMode, MAX_COUNTED_TIME_MS};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Session {
    pub part: u8,
    pub correct: u32,
    pub total: u32,
    pub date: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredLesson {
    pub id: String,
    pub part: u8,
    pub question_id: String,
    pub selected_key: String,
    pub topic: String,
    pub title: String,
    pub rule: String,
    pub example: String,
    pub exercise: String,
    pub answer: String,
    pub tip: String,
    pub created_at: DateTime<Utc>,
    /// `pending`, `ready` ou `error`.
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Diagnostic {
    pub correct: u32,
    pub total: u32,
    pub date: DateTime<Utc>,
}

/// Examen blanc en cours (questions mémorisées : le tirage est aléatoire, on le retrouve au rechargement).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExamSession {
    pub state: lernoviq_core::exam::ExamState,
    pub questions: Vec<lernoviq_models::Question>,
    pub passages: Vec<lernoviq_models::Passage>,
    pub reduced: bool,
    pub notice: String,
    pub index: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AppData {
    pub exam: Option<ExamSession>,
    pub attempts: Vec<Attempt>,
    pub cards: Vec<ReviewCard>,
    pub vocab: Vec<VocabWord>,
    pub exams: Vec<ExamRecord>,
    pub goals: Option<Goals>,
    pub sessions: Vec<Session>,
    pub lessons: Vec<StoredLesson>,
    pub diagnostic: Option<Diagnostic>,
}

impl AppData {
    pub fn goals(&self) -> Goals {
        self.goals.clone().unwrap_or_default()
    }

    /// Enregistre une réponse : historique + carte de révision espacée.
    pub fn record_answer(
        &mut self,
        q: &lernoviq_models::Question,
        selected: char,
        time_ms: f64,
        mode: AttemptMode,
        spaced: bool,
    ) {
        let now = bridge::now();
        let time = (time_ms.round().max(0.0) as i64).min(MAX_COUNTED_TIME_MS * 4);
        self.attempts.insert(
            0,
            Attempt {
                id: bridge::uuid(),
                question_id: q.id.clone(),
                part: q.part,
                category: q.category.clone(),
                selected_key: selected.to_string(),
                correct: selected == crate::bank::key_char(q.correct_key),
                time_ms: time,
                at: now,
                mode,
                owner: None,
                synced: false,
            },
        );
        self.attempts.truncate(MAX_LOCAL_ATTEMPTS);
        if spaced {
            let correct = selected == crate::bank::key_char(q.correct_key);
            self.cards = apply_answer(
                &self.cards,
                &AnswerEvent {
                    question_id: q.id.clone(),
                    part: q.part,
                    correct,
                },
                now,
            );
        }
    }

    pub fn save_session(&mut self, part: u8, correct: u32, total: u32) {
        if total == 0 {
            return;
        }
        let now = bridge::now();
        if let Some(last) = self.sessions.first() {
            if last.part == part
                && last.correct == correct
                && last.total == total
                && (now - last.date).num_milliseconds() < 3000
            {
                return;
            }
        }
        self.sessions.insert(
            0,
            Session {
                part,
                correct,
                total,
                date: now,
            },
        );
        self.sessions.truncate(100);
    }

    pub fn start_lesson(&mut self, q: &lernoviq_models::Question, selected: char) -> String {
        let id = format!("{}:{selected}", q.id);
        if !self.lessons.iter().any(|l| l.id == id) {
            self.lessons.insert(
                0,
                StoredLesson {
                    id: id.clone(),
                    part: q.part,
                    question_id: q.id.clone(),
                    selected_key: selected.to_string(),
                    topic: "À identifier".into(),
                    title: format!("Erreur à travailler · Partie {}", q.part),
                    rule: String::new(),
                    example: String::new(),
                    exercise: String::new(),
                    answer: String::new(),
                    tip: String::new(),
                    created_at: bridge::now(),
                    status: "pending".into(),
                },
            );
            self.lessons.truncate(200);
        }
        id
    }

    pub fn finish_lesson(&mut self, id: &str, lesson: Option<&serde_json::Value>) {
        let Some(l) = self.lessons.iter_mut().find(|l| l.id == id) else {
            return;
        };
        match lesson {
            Some(v) => {
                let text = |k: &str| v[k].as_str().unwrap_or_default().to_string();
                l.topic = text("topic");
                l.title = text("title");
                l.rule = text("rule");
                l.example = text("example");
                l.exercise = text("exercise");
                l.answer = text("answer");
                l.tip = text("tip");
                l.status = "ready".into();
            }
            None if l.status == "pending" => l.status = "error".into(),
            None => {}
        }
    }
}

/// Réglages (hors données d'apprentissage).
#[derive(Debug, Clone, PartialEq)]
pub struct Settings {
    /// Clé DeepSeek personnelle : en mémoire, mémorisée seulement sur demande.
    pub api_key: Option<String>,
    pub remembered: bool,
    pub open: bool,
}

const KEY_STORAGE: &str = "deepseek_user_api_key";

impl Default for Settings {
    fn default() -> Self {
        let stored = bridge::local_get(KEY_STORAGE).filter(|k| !k.is_empty());
        Self {
            remembered: stored.is_some(),
            api_key: stored,
            open: false,
        }
    }
}

impl Settings {
    pub fn save_key(&mut self, key: &str, remember: bool) {
        let key = key.trim();
        if key.is_empty() {
            return;
        }
        bridge::local_set(KEY_STORAGE, if remember { key } else { "" });
        self.api_key = Some(key.to_string());
        self.remembered = remember;
    }

    pub fn clear_key(&mut self) {
        bridge::local_set(KEY_STORAGE, "");
        self.api_key = None;
        self.remembered = false;
    }
}

#[derive(Clone, Copy)]
pub struct Ctx {
    pub data: Signal<AppData>,
    pub settings: Signal<Settings>,
}

/// Installe le contexte, charge les données puis les enregistre à chaque changement.
pub fn provide_state() -> Ctx {
    let data = use_context_provider(|| Signal::new(AppData::default()));
    let settings = use_context_provider(|| Signal::new(Settings::default()));
    let mut loaded = use_context_provider(|| Signal::new(false));

    let mut data_w = data;
    use_future(move || async move {
        if let Some(json) = bridge::load_state().await {
            if let Ok(parsed) = serde_json::from_str::<AppData>(&json) {
                data_w.set(parsed);
            }
        }
        loaded.set(true);
    });

    use_effect(move || {
        let snapshot = data.read().clone();
        if loaded() {
            if let Ok(json) = serde_json::to_string(&snapshot) {
                spawn(async move { bridge::save_state(json).await });
            }
        }
    });
    Ctx { data, settings }
}

pub fn use_ctx() -> Ctx {
    Ctx {
        data: use_context(),
        settings: use_context(),
    }
}
