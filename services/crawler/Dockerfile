ARG CRAWL4AI_VERSION=0.9.2
FROM docker.io/unclecode/crawl4ai:${CRAWL4AI_VERSION}

USER root
COPY services/crawler/npati_server.py /app/npati_server.py
COPY services/crawler/supervisord.conf /app/supervisord.conf
COPY services/crawler/npati-entrypoint.sh /app/npati-entrypoint.sh
RUN chmod 0755 /app/npati-entrypoint.sh
ENTRYPOINT ["bash", "/app/npati-entrypoint.sh"]
CMD []