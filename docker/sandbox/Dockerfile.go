# syntax=docker/dockerfile:1.7
#
# C1b: Go sandbox variant — closes the gap C1 left open (detection reported Go without a runtime).
ARG BASE_IMAGE=ghcr.io/npati-ai/npati-sandbox-base@sha256:0000000000000000000000000000000000000000000000000000000000000000
FROM ${BASE_IMAGE}

USER root
# The Go toolchain version is pinned by the base image digest; GOTOOLCHAIN=local forbids the go
# command from downloading another toolchain at run time (that would be untrusted network code).
RUN apk add --no-cache go \
 && mkdir -p /home/sandbox/go /home/sandbox/.cache/go-build \
 && chown -R sandbox:sandbox /home/sandbox/go /home/sandbox/.cache

USER 10001:10001
ENV GOPATH=/home/sandbox/go \
    GOCACHE=/home/sandbox/.cache/go-build \
    GOTOOLCHAIN=local \
    GOFLAGS=-mod=mod
RUN go version && go env GOTOOLCHAIN
WORKDIR /workspace
CMD ["sleep", "infinity"]
