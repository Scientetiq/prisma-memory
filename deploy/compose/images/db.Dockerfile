# The db image of the public install path (deploy/compose): the pinned PostgreSQL 16 + pgvector of
# deploy/node-version.json, the schema files and the schema step. Built on the user's machine from the repository root
# (build context ../..); db.Dockerfile.dockerignore beside this file lets only the schema folder's top-level files and
# deploy/compose/db/ into the context.
#   /schema/                  contracts/schema/manifest.tsv and the top-level *.sql files, read-only
#   /usr/local/bin/memory-schema   the schema step (the migrate job runs `memory-schema apply`)
#   /etc/postgresql/pg_hba.conf    client authentication: postgres only on the socket, five core roles over TCP
# Nothing goes into /docker-entrypoint-initdb.d: the schema is applied by the migrate job, on every install and upgrade,
# never by the entrypoint of a first start. No secret, no Node, no Python, no test script is in this image.
FROM pgvector/pgvector:pg16@sha256:ccc6e83d6e35e931dc7c5def2022729d5a6c370318d099181995567ff1fb4d6b
LABEL org.opencontainers.image.licenses="LicenseRef-Prisma-Memory"
COPY --chmod=0444 contracts/schema/manifest.tsv contracts/schema/*.sql /schema/
# The copy step above creates /schema with the mode of its files (0444). A folder needs the search bit, and the install
# runs every container under the installing account's uid, never as root: the files stay 0444, the folder becomes 0555.
RUN chmod 0555 /schema
COPY --chmod=0555 deploy/compose/db/memory-schema /usr/local/bin/memory-schema
COPY --chmod=0444 deploy/compose/db/pg_hba.conf /etc/postgresql/pg_hba.conf
CMD ["postgres", "-c", "hba_file=/etc/postgresql/pg_hba.conf"]
