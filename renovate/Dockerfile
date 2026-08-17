# renovate: datasource=docker depName=library/node versioning=docker
ARG RENOVATE_BASE_IMAGE=docker.io/library/node:24.19.0-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03
FROM ${RENOVATE_BASE_IMAGE}

ARG RENOVATE_NPM_MIN_RELEASE_AGE_DAYS
ARG RENOVATE_VERSION

# hadolint ignore=DL3008
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && if [ -n "${RENOVATE_NPM_MIN_RELEASE_AGE_DAYS}" ]; then \
    npm install --global \
      --ignore-scripts \
      --loglevel=error \
      --no-audit \
      --no-fund \
      --update-notifier=false \
      --min-release-age="${RENOVATE_NPM_MIN_RELEASE_AGE_DAYS}" \
      "renovate@${RENOVATE_VERSION}"; \
  else \
    npm install --global \
      --ignore-scripts \
      --loglevel=error \
      --no-audit \
      --no-fund \
      --update-notifier=false \
      "renovate@${RENOVATE_VERSION}"; \
  fi

# hadolint ignore=DL3066
USER node
HEALTHCHECK NONE
