# ja2-web test pipeline (Jenkins → build server → test app server)

Mirrors the morrowind (CS-Web) setup. Builds the WASM engine on the build server (the dev
laptop is too weak) and deploys to the **test** app server — never production. Production
(ja2.virtastic.app) is the separate GitHub Actions → OVH path (`.github/workflows/deploy-ovh.yml`).

## Servers (Virtastic proxmox lab)

| Role          | ssh alias / host         | what it is                          |
|---------------|--------------------------|-------------------------------------|
| Build server  | `jenkins-vm`             | Jenkins + Docker. All builds here.  |
| Test app srv  | `testapp@192.168.1.131`  | Runs `ja2-test` (nginx) on `:8081`. |
| Ingress       | nginx-proxy-manager      | SNI/TLS; routes `ja2.dev.virtastic.app` → `192.168.1.131:8081` |

`ci/jenkins/config.env` (gitignored — copy `config.env.example`) holds these values; env vars
override it, which is what a Jenkins job should do.

## Flow

```bash
ci/jenkins/sync-to-builder.sh                 # rsync the working tree → jenkins-vm:ja2-src
ssh jenkins-vm 'cd ja2-src && SRC=$PWD ci/jenkins/build-engine.sh'   # docker build ja2:test
ssh jenkins-vm 'cd ja2-src && ci/jenkins/deploy-test.sh'            # save|load → run on test-vm:8081
ci/jenkins/smoke-test.sh https://ja2.dev.virtastic.app             # contract check
```

First build bootstraps `ja2-builder:1` (emscripten 6.0.1 + Rust nightly) on jenkins-vm —
one-time, ~20-40 min. Later builds are just the incremental engine compile.

## Jenkins job

A freestyle/pipeline job that runs the four steps above with the repo checked out and
`ci/jenkins/config.env` present (or the same values as job env / credentials). The SSH key the
build server uses to reach the test server lives on the build server, never in git.
