# MFA (TOTP) de l'administration : préparation

Statut : **préparée, non imposée.** La connexion admin fonctionne exactement comme avant (identifiant + mot de passe). Ce document décrit ce qui existe déjà et la marche à suivre pour activer la MFA.

## Ce qui est déjà en place

- `server/totp.mjs` : TOTP conforme à la RFC 6238 (HMAC-SHA1, pas de 30 s, 6 chiffres) — génération de secret, calcul, vérification avec tolérance d'un pas, URL `otpauth://`. Testé avec les vecteurs officiels (`tests/audit.test.mjs`).
- `supabase/admin_audit.sql` : colonnes sur `lexora_admin_users` — `totp_secret_enc` (secret chiffré), `totp_enabled` (faux par défaut), `totp_recovery_hashes` (codes de secours hachés).
- Journal d'audit : les connexions réussies et les changements de compte sont déjà tracés ; l'activation de la MFA devra l'être aussi (voir §3).

## Marche à suivre pour l'activer

### 1. Exécuter la migration
Exécutez `supabase/admin_audit.sql` dans l'éditeur SQL de Supabase (idempotent).

### 2. Chiffrer le secret au repos
Ne **jamais** stocker le secret TOTP en clair. Chiffrer avec AES-256-GCM, clé dérivée de `ADMIN_SESSION_SECRET` (ou, mieux, d'une variable dédiée `ADMIN_MFA_KEY`, 32 octets aléatoires en base64) ; stocker `iv:tag:ciphertext` dans `totp_secret_enc`. Changer cette clé invalide les secrets existants : prévoir une procédure de ré-enrôlement.

### 3. Parcours d'activation (par compte)
1. L'administrateur connecté appelle une nouvelle action `mfa-begin` : le serveur génère `generateSecret()`, le renvoie avec l'URL `otpauthUrl()` (affichée en QR code) et le garde **en attente** (non activé).
2. L'utilisateur scanne le QR code (application d'authentification) et saisit un premier code.
3. Action `mfa-confirm` : si `verifyTotp()` réussit, le serveur chiffre et stocke le secret, passe `totp_enabled = true`, génère 8 codes de secours (affichés une seule fois, stockés **hachés** avec scrypt comme les mots de passe) et écrit l'événement d'audit `mfa.enable`.
4. Incrémenter `session_version` pour invalider les sessions existantes.

### 4. Connexion avec MFA
- Après un mot de passe correct, si `totp_enabled`, le serveur ne pose **pas** le cookie de session : il renvoie `{ mfaRequired: true }` avec un jeton court (5 min, signé comme le cookie, limité à cette étape).
- Action `mfa-verify` : code TOTP ou code de secours (usage unique, retiré de `totp_recovery_hashes`). La limitation de tentatives (`admin_login_attempt`) s'applique aussi à cette étape (clé `mfa:<identifiant>`).
- Rejeter un code TOTP déjà utilisé dans la même fenêtre (stocker le dernier pas accepté) pour empêcher le rejeu.

### 5. Politique et reprise
- Variable `ADMIN_MFA_REQUIRED` (à créer) : `false` par défaut ; `true` impose la MFA aux comptes `admin` après un délai de grâce.
- Perte de l'appareil : un autre administrateur réinitialise la MFA du compte (action tracée `mfa.reset` + invalidation des sessions). Prévoir au moins deux administrateurs.
- Le dernier administrateur ne doit pas pouvoir désactiver sa propre MFA sans code valide.

## À ne pas faire
- Ne pas journaliser les secrets ni les codes (la fonction `sanitizeDetails` de `server/audit.mjs` retire déjà les clés sensibles).
- Ne pas envoyer le secret au navigateur après l'étape d'activation.
- Ne pas contourner la limitation de tentatives pour l'étape MFA : un code à 6 chiffres se devine par force brute sans elle.
