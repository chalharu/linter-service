# renovate: datasource=docker depName=library/node versioning=docker
ARG RENOVATE_BASE_IMAGE=docker.io/library/node:24-bookworm-slim@sha256:b506e7321f176aae77317f99d67a24b272c1f09f1d10f1761f2773447d8da26c
FROM ${RENOVATE_BASE_IMAGE}

ARG RENOVATE_NPM_MIN_RELEASE_AGE_DAYS=3
ARG RENOVATE_VERSION

# hadolint ignore=DL3008
RUN apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install --yes --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && npm install --global \
    --ignore-scripts \
    --loglevel=error \
    --no-audit \
    --no-fund \
    --update-notifier=false \
    --min-release-age=${RENOVATE_NPM_MIN_RELEASE_AGE_DAYS} \
    renovate@${RENOVATE_VERSION}

USER node
HEALTHCHECK NONE
