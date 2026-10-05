# syntax=docker/dockerfile:1.7
#
# C1b: Java sandbox variant (JDK 21 + Maven + Gradle, the two build tools detection reports).
ARG BASE_IMAGE=ghcr.io/npati-ai/npati-sandbox-base@sha256:0000000000000000000000000000000000000000000000000000000000000000
FROM ${BASE_IMAGE}

USER root
# Versions come from the digest-pinned base image (apk openjdk/maven/gradle).
RUN apk add --no-cache openjdk21-jdk maven gradle \
 && mkdir -p /home/sandbox/.m2 /home/sandbox/.gradle \
 && chown -R sandbox:sandbox /home/sandbox/.m2 /home/sandbox/.gradle

USER 10001:10001
ENV JAVA_HOME=/usr/lib/jvm/java-21-openjdk \
    MAVEN_OPTS="-Dmaven.repo.local=/home/sandbox/.m2/repository" \
    GRADLE_USER_HOME=/home/sandbox/.gradle
RUN java -version && mvn --version && gradle --version
WORKDIR /workspace
CMD ["sleep", "infinity"]
