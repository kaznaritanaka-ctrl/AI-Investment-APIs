# Both inputs are supplied by the operator after verifying the official publisher.
# NODE_IMAGE must be a Node 24 Linux amd64 image pinned by sha256 digest.
ARG NODE_IMAGE
FROM ${NODE_IMAGE}
ARG AGE_SHA256
ARG AGE_KEYGEN_SHA256
COPY deploy/nas-backup/vendor/age /usr/local/bin/age
COPY deploy/nas-backup/vendor/age-keygen /usr/local/bin/age-keygen
RUN test "${#AGE_SHA256}" -eq 64 && test "${#AGE_KEYGEN_SHA256}" -eq 64 \
    && printf '%s  /usr/local/bin/age\n%s  /usr/local/bin/age-keygen\n' "$AGE_SHA256" "$AGE_KEYGEN_SHA256" | sha256sum -c - \
    && chmod 0555 /usr/local/bin/age /usr/local/bin/age-keygen
WORKDIR /app
COPY scripts/backup-package.mjs scripts/backup-capture.mjs scripts/backup-roundtrip.test.mjs scripts/backup-capture.test.mjs ./scripts/
COPY config/sources/ecb.json config/sources/models_dev.json config/sources/price_of_compute.json ./config/sources/
ENV AGE_BINARY=/usr/local/bin/age
USER 10001:10001
ENTRYPOINT ["node"]
CMD ["--test", "scripts/backup-roundtrip.test.mjs", "scripts/backup-capture.test.mjs"]
