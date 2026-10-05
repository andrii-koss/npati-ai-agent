# syntax=docker/dockerfile:1.7
#
# C1b: PHP sandbox variant (php + composer, with the phar toolchain).
ARG BASE_IMAGE=ghcr.io/npati-ai/npati-sandbox-base@sha256:0000000000000000000000000000000000000000000000000000000000000000
FROM ${BASE_IMAGE}

USER root
RUN apk add --no-cache php php-phar php-openssl php-tokenizer php-mbstring php-xml php-curl php-json composer

USER 10001:10001
ENV COMPOSER_HOME=/home/sandbox/.composer \
    COMPOSER_ALLOW_SUPERUSER=0 \
    COMPOSER_NO_INTERACTION=1
RUN php --version && composer --version
WORKDIR /workspace
CMD ["sleep", "infinity"]
