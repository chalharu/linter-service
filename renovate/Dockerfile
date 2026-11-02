# renovate: datasource=docker depName=library/node versioning=docker
ARG RENOVATE_BASE_IMAGE=docker.io/library/node:26.13.0-bookworm-slim@sha256:bc0a2afd3b74ce12222fc8bab99271e66257f021078f5f4a5d687a77d280c1d9
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
