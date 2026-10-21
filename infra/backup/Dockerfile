# Same major version as the postgres service, so pg_dump matches the server.
FROM postgres:16-alpine
RUN apk add --no-cache rclone age tzdata
# No config file: remotes come from RCLONE_CONFIG_<NAME>_* variables only.
ENV RCLONE_CONFIG=""
COPY backup.sh /usr/local/bin/backup.sh
RUN chmod +x /usr/local/bin/backup.sh
USER postgres
ENTRYPOINT ["/usr/local/bin/backup.sh"]
