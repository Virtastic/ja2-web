// Jenkins pipeline for ja2-web: build the WASM engine + the Cloud Locker backend on the build
// server and deploy both to the test app server. Never touches production (ja2.virtastic.app is
// the separate GitHub Actions -> OVH path, .github/workflows/deploy-ovh.yml).
//
// The job checks this repo out on the builder (Jenkins + Docker live there), so the workspace IS
// the source tree -- ci/jenkins/sync-to-builder.sh is only for the manual laptop-driven flow.
// config.env is gitignored and absent in a fresh checkout, so every value comes from
// `environment {}` below (env overrides config.env per the scripts' precedence).
pipeline {
  agent any
  options { timestamps(); disableConcurrentBuilds(); timeout(time: 90, unit: 'MINUTES') }
  environment {
    TAG       = 'ja2:test'
    NAME      = 'ja2-test'
    PORT      = '8081'
    NET       = 'ja2net'
    // Host, user and key path are deliberately NOT in this file: it is public. Set them on the
    // job (Manage Jenkins -> System -> Global properties -> Environment variables). The defaults
    // below are placeholders and will not deploy anywhere.
    TEST_HOST = "${env.JA2_TEST_HOST ?: 'user@test-host.example'}"
    SSH_KEY   = "${env.JA2_SSH_KEY ?: '/var/jenkins_home/.ssh/your-deploy-key'}"
    SMOKE_URL = 'https://ja2.dev.virtastic.app'
  }
  stages {
    // First build on a fresh builder bootstraps ja2-builder:1 (emscripten 6.0.1 + Rust nightly),
    // which is why the timeout above is 90 minutes rather than the 60 the game ports use.
    stage('Build')  { steps { sh 'SRC="$WORKSPACE" TAG="$TAG" ci/jenkins/build-engine.sh' } }
    stage('Deploy') { steps { sh 'ci/jenkins/deploy-test.sh' } }
    stage('Smoke') {
      steps {
        // Prefer the public origin; fall back to the container directly so the stage is
        // meaningful even when DNS/ingress is down.
        sh '''
          if [ -n "$SMOKE_URL" ] && curl -sf -o /dev/null --max-time 8 "$SMOKE_URL/" 2>/dev/null; then
            ci/jenkins/smoke-test.sh "$SMOKE_URL"
          else
            echo "public origin not reachable yet; smoke-testing the container directly"
            ci/jenkins/smoke-test.sh "http://${TEST_HOST#*@}:$PORT"
          fi
        '''
      }
    }
  }
  post {
    success { echo "ja2 built and deployed to the test server on :${env.PORT}" }
    failure { echo 'ja2 test pipeline failed — see stage logs' }
  }
}
