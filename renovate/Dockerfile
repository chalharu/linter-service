# renovate: datasource=docker depName=library/node versioning=docker
ARG RENOVATE_BASE_IMAGE=docker.io/library/node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d
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

USER node
HEALTHCHECK NONE
