# Candidate only. Build on a Linux amd64 checkout after pnpm install --frozen-lockfile.
# Dependencies come from that locked checkout; no install or credentials at runtime.
ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS runtime
ARG AGE_SHA256
ARG AGE_KEYGEN_SHA256
COPY deploy/nas-backup/vendor/age /usr/local/bin/age
COPY deploy/nas-backup/vendor/age-keygen /usr/local/bin/age-keygen
RUN test "${#AGE_SHA256}" -eq 64 && test "${#AGE_KEYGEN_SHA256}" -eq 64 \
    && printf '%s  /usr/local/bin/age\n%s  /usr/local/bin/age-keygen\n' "$AGE_SHA256" "$AGE_KEYGEN_SHA256" | sha256sum -c - \
    && chmod 0555 /usr/local/bin/age /usr/local/bin/age-keygen \
    && test -x /usr/bin/flock
WORKDIR /app
COPY package.json ./
COPY node_modules ./node_modules
COPY src ./src
COPY config/gpu-catalog.json ./config/gpu-catalog.json
COPY scripts/personal*.ts scripts/personal-nas-runner.mjs scripts/daily-nas*.ts scripts/migrations.ts ./scripts/
COPY migrations/private ./migrations/private
ENV AGE_BINARY=/usr/local/bin/age
# CI identity only; a real NAS UID/GID must be separately selected and reviewed.
USER 10001:10001
ENTRYPOINT ["node"]
CMD ["scripts/personal-nas-runner.mjs", "plan"]

FROM runtime AS verify
COPY tests ./tests
COPY vitest.config.ts ./
COPY config/proposals ./config/proposals
COPY scripts/personal-nas-container-check.mjs ./scripts/
CMD ["scripts/personal-nas-container-check.mjs"]
