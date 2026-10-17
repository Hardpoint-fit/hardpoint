#!/usr/bin/env bash
# hardpoint.fit on Railway: the site, the re-evaluation cron and their Postgres. They share project
# citadel-game-data with the game data API, whose own deploy.sh (tools/game-data-api/deploy in the Citadel
# monorepo) creates the project and owns the api service. Neither script touches the other's services.
#
#   deploy.sh setup                 reconcile the site's services, settings, variables and domains (safe to re-run)
#   deploy.sh dns                   print the DNS records the custom domains need
#   deploy.sh oauth <client_id>     turn on "Sign in with Citadel": the Clerk OAuth app's client id as the
#                                   argument, its client secret on the clipboard; also sets SESSION_SECRET
#                                   once and SITE_URL
#
# Railway builds the site and the cron from GitHub: a push to $BRANCH of $GITHUB_REPO deploys both, once
# CI passes on the commit. A site change that needs a newer API ships after that API is live.
#
# Needs a logged-in `railway` CLI and `jq`. Railway calls run from $HARDPOINT_DEPLOY_DIR (default:
# $TMPDIR/hardpoint-deploy), linked to the project, never from the repo.
set -euo pipefail

PROJECT=citadel-game-data
WORKSPACE=Martino
ENVIRONMENT=production
REGION=us-east4-eqdc4a
GITHUB_REPO=iloveenergydrinks/hardpoint
BRANCH=main
# hardpoint.fit is the canonical name (registered on Namecheap): sign-in completes there, and the site
# redirects www.hardpoint.fit to it. fits.alpha.thecitadel.com and the Railway domain serve the same site.
CUSTOM_DOMAINS=(hardpoint.fit www.hardpoint.fit fits.alpha.thecitadel.com)
SITE_URL=https://hardpoint.fit
# The game data API's public name, served by the api service.
API_URL=https://api.thecitadel.com
SITE_PORT=3000

WORK=${HARDPOINT_DEPLOY_DIR:-${TMPDIR:-/tmp}/hardpoint-deploy}

die() { echo "deploy.sh: $*" >&2; exit 1; }
log() { echo "==> $*" >&2; }

project_id() {
  railway list --json | jq -r --arg n "$PROJECT" --arg w "$WORKSPACE" \
    '[.[] | select(.name == $n and .workspace.name == $w)][0].id // empty'
}

# Every railway call runs from $WORK, linked to the project and environment.
link() {
  mkdir -p "$WORK"
  cd "$WORK"
  local id
  id=$(project_id)
  [[ -n "$id" ]] || die "project $PROJECT not found; the game data API's deploy.sh setup creates it"
  railway link -p "$id" -e "$ENVIRONMENT" -w "$WORKSPACE" >/dev/null
}

service_id() { railway service list --json | jq -r --arg n "$1" '.[] | select(.name == $n) | .id'; }

ensure_service() {
  if [[ -z "$(service_id "$1")" ]]; then
    log "adding service $1"
    railway add -s "$1" --json >/dev/null
  fi
}

ensure_domains() {
  local service=$1 port=$2 domains custom
  domains=$(railway domain list -s "$service" --json)
  for custom in "${@:3}"; do
    if [[ -z "$(jq -r --arg d "$custom" '.domains[] | select(.domain == $d) | .id' <<<"$domains")" ]]; then
      log "adding custom domain $custom to $service"
      railway domain "$custom" -s "$service" -p "$port" --json >/dev/null
    fi
  done
}

setup() {
  link
  [[ -n "$(service_id api)" ]] || die "no api service; the game data API's deploy.sh setup creates it"
  if [[ -z "$(service_id Postgres)" ]]; then
    log "adding Postgres"
    railway add -d postgres --json >/dev/null
  fi
  ensure_service site
  ensure_service reevaluate
  ensure_domains site "$SITE_PORT" "${CUSTOM_DOMAINS[@]}"

  local postgres site cron
  postgres=$(service_id Postgres)
  site=$(service_id site)
  cron=$(service_id reevaluate)
  log "applying service settings and variables"
  # Settings live here, not in a railway.json, so one place owns them. Both services build this repo's
  # Dockerfile from GitHub and wait for its CI. The cron never restarts on failure, so a failing run waits
  # for the next schedule instead of looping. Postgres has no public TCP proxy: only the site and the cron
  # reach it, privately.
  jq -n \
    --arg postgres "$postgres" --arg site "$site" --arg cron "$cron" \
    --arg region "$REGION" --arg sitePort "$SITE_PORT" --arg siteUrl "$SITE_URL" --arg apiUrl "$API_URL" \
    --arg repo "$GITHUB_REPO" --arg branch "$BRANCH" '
    def regions: {multiRegionConfig: {($region): {numReplicas: 1}}};
    def source: {repo: $repo, branch: $branch, checkSuites: true};
    def build: {builder: "DOCKERFILE", dockerfilePath: "Dockerfile"};
    def internal: "http://${{api.RAILWAY_PRIVATE_DOMAIN}}:${{api.PORT}}";
    {services: {
      ($postgres): {deploy: regions},
      ($site): {
        source: source, build: build,
        deploy: (regions + {healthcheckPath: "/healthz", healthcheckTimeout: 120,
                 restartPolicyType: "ON_FAILURE", restartPolicyMaxRetries: 5}),
        variables: {PORT: {value: $sitePort}, SITE_URL: {value: $siteUrl},
          GAME_DATA_API_URL: {value: $apiUrl},
          GAME_DATA_API_INTERNAL_URL: {value: internal},
          DATABASE_URL: {value: "${{Postgres.DATABASE_URL}}"}}},
      ($cron): {
        source: source, build: build,
        deploy: (regions + {startCommand: "node src/jobs/reevaluate.ts", cronSchedule: "*/15 * * * *",
                 restartPolicyType: "NEVER"}),
        variables: {GAME_DATA_API_INTERNAL_URL: {value: internal},
          DATABASE_URL: {value: "${{Postgres.DATABASE_URL}}"}}}
    }}' | railway environment edit --json -m "hardpoint deploy.sh setup" >/dev/null
  dns
}

dns() {
  local custom
  for custom in "${CUSTOM_DOMAINS[@]}"; do
    railway domain status "$custom" -s site --json | jq -r '.domain
      | (.dnsRecords[] | "\(.recordType | sub("DNS_RECORD_TYPE_"; ""))  \(.fqdn)  ->  \(.requiredValue)  [\(.status | sub("DNS_RECORD_STATUS_"; ""))]"),
        (.verification | select(. != null) | "TXT  \(.dnsHost) (host, relative to the zone)  ->  \(.token)  [verified: \(.verified)]")'
  done
}

# "Sign in with Citadel": the site is a confidential OAuth client of the production Clerk instance (the
# "Citadel Fits" OAuth app). Takes the app's client id as the argument and its client secret from the
# clipboard, so the secret never appears in argv, history or output; secrets go to Railway through
# --stdin. SESSION_SECRET (the session cookies' key) is generated once and kept on later runs, since
# replacing it signs everyone out. The retired Clerk SDK keys are deleted.
oauth() {
  local client_id=${1:-} secret session_secret variables
  [[ -n "$client_id" && "$client_id" != *[[:space:]]* ]] || die "usage: deploy.sh oauth <client_id>  (client secret on the clipboard)"
  secret=$(pbpaste) || die "cannot read the clipboard (pbpaste)"
  [[ -n "$secret" ]] || die "the clipboard is empty; copy the OAuth app's client secret first"
  [[ "$secret" != *[[:space:]]* ]] || die "the clipboard holds more than one word; copy only the OAuth app's client secret"
  link
  # Only the names are kept: whether SESSION_SECRET and the old Clerk keys exist.
  variables=$(railway variable list -s site --json | jq -c 'keys') || die "cannot read the site's variables"
  printf '%s' "$client_id" | railway variable set CITADEL_OAUTH_CLIENT_ID --stdin -s site --skip-deploys >/dev/null \
    || die "could not set CITADEL_OAUTH_CLIENT_ID"
  printf '%s' "$secret" | railway variable set CITADEL_OAUTH_CLIENT_SECRET --stdin -s site --skip-deploys >/dev/null \
    || die "could not set CITADEL_OAUTH_CLIENT_SECRET"
  secret=""
  pbcopy </dev/null || die "could not clear the clipboard; clear it by hand, it still holds the client secret"
  log "set CITADEL_OAUTH_CLIENT_SECRET and cleared the clipboard"
  if [[ "$(jq 'index("SESSION_SECRET") != null' <<<"$variables")" != true ]]; then
    session_secret=$(openssl rand -base64 48 | tr -d '\n') || die "openssl rand failed"
    printf '%s' "$session_secret" | railway variable set SESSION_SECRET --stdin -s site --skip-deploys >/dev/null \
      || die "could not set SESSION_SECRET"
    log "generated SESSION_SECRET"
  else
    log "kept the existing SESSION_SECRET"
  fi
  local old
  for old in NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY CLERK_SECRET_KEY; do
    if [[ "$(jq --arg n "$old" 'index($n) != null' <<<"$variables")" == true ]]; then
      railway variable delete "$old" -s site >/dev/null || die "could not delete $old"
      log "deleted $old"
    fi
  done
  # The last change deploys, so the site restarts once with everything in place.
  printf '%s' "$SITE_URL" | railway variable set SITE_URL --stdin -s site --skip-deploys >/dev/null || die "could not set SITE_URL"
  # One explicit redeploy after every variable is saved: a deploy triggered by a variable set can start
  # before the earlier --skip-deploys sets land, and boot without sign-in.
  railway redeploy -s site -y >/dev/null || die "could not redeploy site"
  log "sign-in configured on site; it redeploys now. Redirect URI to register on the Clerk OAuth app: $SITE_URL/auth/callback"
}

case ${1:-} in
  setup) setup ;;
  dns) link; dns ;;
  oauth) shift; oauth "$@" ;;
  *) awk 'NR > 1 && /^# Needs/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$0"; exit 1 ;;
esac
