# Compiler, publier et mettre à jour Lernoviq (Windows)

## Prérequis de développement
- Rust stable (chaîne **MSVC** pour l'installateur) avec la cible `wasm32-unknown-unknown`.
- Visual Studio Build Tools (charge de travail « Développement Desktop en C++ ») et WebView2.
- `cargo install dioxus-cli --version 0.7.10 --locked` et `cargo install tauri-cli --version "^2" --locked`.

## Commandes
```bash
cargo test --workspace                 # tests Rust
cargo tauri build                      # installateur NSIS (target/release/bundle/nsis)
```
Sans la clé privée, ajouter `--config '{"bundle":{"createUpdaterArtifacts":false}}'`.

## Clé de signature des mises à jour (une seule fois)
1. `cargo tauri signer generate -w lernoviq.key` (la clé publique est déjà dans `src-tauri/tauri.conf.json`).
2. Dans GitHub → Settings → Secrets and variables → Actions, créer :
   - `TAURI_SIGNING_PRIVATE_KEY` : le contenu du fichier `lernoviq.key` ;
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` : le mot de passe, vide si aucun.
3. Ne jamais committer la clé privée. Si elle est perdue, les installations existantes ne pourront plus être mises à jour.

## Publier une version
1. Mettre à jour `version` dans `Cargo.toml` (`[workspace.package]`), commiter sur `main`.
2. `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. Le workflow **Release** vérifie que tag = version, exécute fmt/clippy/tests, compile, signe, publie la GitHub Release avec l'installateur, les fichiers `.sig` et `latest.json`.
4. Vérifier que `https://github.com/Teamfliyou/toeic-reading-ai-coach/releases/latest/download/latest.json` répond et que les signatures correspondent.

Les builds de pull request produisent uniquement un artifact de développement, jamais une release.

## Limites connues
- L'installateur n'est pas signé Authenticode : Windows SmartScreen peut avertir tant qu'aucun certificat de signature de code n'est configuré.
- La transition entre deux versions réelles n'a pas encore été testée (il faut publier deux tags).
