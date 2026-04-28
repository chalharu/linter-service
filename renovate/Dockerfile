# renovate: datasource=docker depName=library/node versioning=docker
ARG RENOVATE_BASE_IMAGE=docker.io/library/node:24-bookworm-slim@sha256:03eae3ef7e88a9de535496fb488d67e02b9d96a063a8967bae657744ecd513f2
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
