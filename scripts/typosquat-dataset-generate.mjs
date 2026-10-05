#!/usr/bin/env node
/**
 * C4a: regenerates the curated typosquat datasets in `data/typosquat/`.
 *
 * The dataset is curated (no external ranking API at runtime): the lists below are the most
 * commonly impersonated package names per ecosystem, and the `hash` field is the sha256 of the
 * canonical JSON of the name array (sorted, stable stringify) so the loader can detect tampering.
 *
 * Usage: node scripts/typosquat-dataset-generate.mjs [--check]
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DIRECTORY = path.join(ROOT, "data", "typosquat");
const DATASET_VERSION = "2026.10.1";
/**
 * Regenerate (or bump) whenever the curated lists change: a dataset older than the configured limit
 * (`NPATI_CODE_TYPOSQUAT_MAX_AGE_DAYS`, default 365 days) is refused at load time by design, so a
 * released dataset must be refreshed at least once a year.
 */
const GENERATED_AT = "2026-10-05T00:00:00.000Z";

/** Canonical JSON: arrays keep order but the name list is sorted first; object keys are sorted. */
export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}

export function datasetHash(packageNames) {
  const canonical = canonicalJson([...packageNames].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
  return `sha256:${createHash("sha256").update(canonical, "utf8").digest("hex")}`;
}

const NAMES = {
  npm: "react,react-dom,lodash,express,axios,typescript,next,vue,angular,jquery,moment,dayjs,chalk,commander,debug,dotenv,eslint,prettier,jest,mocha,webpack,vite,rollup,esbuild,redux,rxjs,zod,yup,uuid,classnames,ramda,underscore,async,bluebird,node-fetch,cross-env,rimraf,glob,minimatch,semver,yargs,inquirer,ora,nodemon,ts-node,tsx,supertest,socket.io,ws,cors,helmet,morgan,bcrypt,jsonwebtoken,passport,mongoose,sequelize,knex,pg,redis,firebase,graphql,tailwindcss,postcss,autoprefixer,sass,styled-components,framer-motion,react-router-dom,react-redux,formik,react-hook-form,vitest,playwright,puppeteer,cheerio,jsdom,fastify,koa,compression,cookie-parser,multer,sharp,marked,dompurify,slugify,nanoid",
  pypi: "requests,numpy,pandas,flask,django,fastapi,pytest,sqlalchemy,pydantic,boto3,urllib3,setuptools,wheel,black,flake8,mypy,ruff,poetry,celery,redis,psycopg2-binary,pymongo,beautifulsoup4,scrapy,selenium,pillow,matplotlib,scipy,scikit-learn,tensorflow,torch,transformers,openai,anthropic,langchain,httpx,aiohttp,tornado,jinja2,click,typer,rich,tqdm,python-dotenv,pyyaml,toml,cryptography,bcrypt,passlib,pyjwt,marshmallow,attrs,orjson,ujson,msgpack,protobuf,grpcio,kafka-python,pika,dask,polars,arrow",
  cargo: "serde,serde_json,tokio,reqwest,clap,anyhow,thiserror,log,env_logger,tracing,rand,regex,chrono,itertools,rayon,futures,async-trait,hyper,axum,actix-web,rocket,warp,tower,sqlx,diesel,rusqlite,redis,mongodb,uuid,base64,hex,sha2,md5,hmac,aes-gcm,ring,rustls,openssl,url,percent-encoding,bytes,byteorder,num-traits,num_cpus,crossbeam,parking_lot,once_cell,lazy_static,indexmap,hashbrown,smallvec,arrayvec,bitflags,libc,tempfile,walkdir,glob,notify,toml,serde_yaml,csv,quick-xml,http,http-body,mio,socket2,slab,pin-project,prost,tonic",
  go: "github.com/gin-gonic/gin,github.com/gorilla/mux,github.com/labstack/echo/v4,github.com/gofiber/fiber/v2,github.com/spf13/cobra,github.com/spf13/viper,github.com/stretchr/testify,github.com/pkg/errors,github.com/sirupsen/logrus,go.uber.org/zap,github.com/google/uuid,github.com/go-sql-driver/mysql,github.com/lib/pq,github.com/jackc/pgx/v5,go.mongodb.org/mongo-driver,github.com/redis/go-redis/v9,github.com/aws/aws-sdk-go-v2,google.golang.org/grpc,google.golang.org/protobuf,github.com/golang-jwt/jwt/v5,golang.org/x/crypto,golang.org/x/net,golang.org/x/sync,golang.org/x/time,gopkg.in/yaml.v3,github.com/BurntSushi/toml,github.com/joho/godotenv,github.com/robfig/cron/v3,github.com/hashicorp/go-retryablehttp,github.com/prometheus/client_golang,go.opentelemetry.io/otel,github.com/segmentio/kafka-go,github.com/rabbitmq/amqp091-go,github.com/nats-io/nats.go,github.com/gorilla/websocket,github.com/gorilla/sessions,github.com/golang-migrate/migrate/v4,github.com/golangci/golangci-lint,github.com/vektra/mockery/v2,github.com/swaggo/swag,github.com/go-chi/chi/v5,github.com/urfave/cli/v2,github.com/mitchellh/mapstructure,github.com/json-iterator/go,github.com/pelletier/go-toml/v2,github.com/mattn/go-sqlite3,github.com/go-redis/redis/v8,github.com/hashicorp/vault/api,github.com/docker/docker,github.com/spf13/pflag,github.com/google/go-cmp,github.com/google/go-github/v60,github.com/shopspring/decimal,github.com/rs/zerolog,github.com/valyala/fasthttp,github.com/elastic/go-elasticsearch/v8,github.com/minio/minio-go/v7",
  composer: "laravel/framework,symfony/console,symfony/http-foundation,guzzlehttp/guzzle,monolog/monolog,phpunit/phpunit,doctrine/orm,doctrine/dbal,composer/composer,twig/twig,nikic/php-parser,psr/log,psr/http-message,phpseclib/phpseclib,vlucas/phpdotenv,ramsey/uuid,nesbot/carbon,league/flysystem,predis/predis,aws/aws-sdk-php,stripe/stripe-php,firebase/php-jwt,phpmailer/phpmailer,sebastian/version,fakerphp/faker,laravel/tinker,symfony/process,symfony/yaml,symfony/var-dumper,composer/ca-bundle,php-di/php-di,nikic/fast-route,slim/slim,respect/validation,filp/whoops,mockery/mockery,phpstan/phpstan,vimeo/psalm,squizlabs/php_codesniffer,friendsofphp/php-cs-fixer,dompdf/dompdf,mpdf/mpdf,phpoffice/phpspreadsheet,endroid/qr-code,intervention/image,spatie/laravel-permission,livewire/livewire,inertiajs/inertia-laravel,pestphp/pest,nunomaduro/collision,orchestra/testbench,pusher/pusher-php-server,nette/utils,latte/latte,barryvdh/laravel-debugbar,barryvdh/laravel-ide-helper,symfony/finder,doctrine/annotations",
  maven: "org.springframework:spring-core,org.springframework:spring-web,org.springframework.boot:spring-boot-starter-web,org.springframework.security:spring-security-core,com.google.guava:guava,org.apache.commons:commons-lang3,com.fasterxml.jackson.core:jackson-databind,org.junit.jupiter:junit-jupiter,org.mockito:mockito-core,org.slf4j:slf4j-api,ch.qos.logback:logback-classic,org.projectlombok:lombok,org.hibernate:hibernate-core,org.postgresql:postgresql,com.h2database:h2,org.apache.maven:maven-core,org.apache.maven.plugins:maven-compiler-plugin,org.apache.maven.plugins:maven-surefire-plugin,com.squareup.okhttp3:okhttp,com.squareup.retrofit2:retrofit,io.reactivex.rxjava3:rxjava,org.jetbrains.kotlin:kotlin-stdlib,org.jetbrains.kotlinx:kotlinx-coroutines-core,org.scala-lang:scala-library,io.micronaut:micronaut-core,io.quarkus:quarkus-core,org.apache.kafka:kafka-clients,org.elasticsearch:elasticsearch,org.apache.httpcomponents:httpclient,com.google.code.gson:gson,org.json:json,jakarta.servlet:jakarta.servlet-api,org.testng:testng,org.assertj:assertj-core,io.netty:netty-all,org.eclipse.jetty:jetty-server,org.apache.tomcat.embed:tomcat-embed-core,com.zaxxer:HikariCP,org.flywaydb:flyway-core,org.liquibase:liquibase-core,redis.clients:jedis,io.lettuce:lettuce-core,software.amazon.awssdk:s3,com.amazonaws:aws-java-sdk-s3,org.apache.poi:poi,com.opencsv:opencsv,org.jsoup:jsoup,org.seleniumhq.selenium:selenium-java,io.rest-assured:rest-assured,org.springframework.cloud:spring-cloud-starter,com.netflix.eureka:eureka-client,org.keycloak:keycloak-core,com.auth0:java-jwt,io.jsonwebtoken:jjwt-api,org.apache.logging.log4j:log4j-core,commons-io:commons-io",
};

const SOURCES = {
  npm: ["https://github.com/npm/registry", "https://blog.snyk.io/npm-package-security"],
  pypi: ["https://pypi.org", "https://pypi.org/security/"],
  cargo: ["https://crates.io", "https://rustsec.org/"],
  go: ["https://pkg.go.dev", "https://go.dev/ref/mod"],
  composer: ["https://packagist.org", "https://blog.packagist.com/"],
  maven: ["https://search.maven.org", "https://mvnrepository.com/"],
};

function buildDataset(ecosystem) {
  const names = [...new Set(NAMES[ecosystem].split(",").map((name) => name.trim()).filter(Boolean))];
  return {
    schemaVersion: 1,
    ecosystem,
    datasetVersion: DATASET_VERSION,
    generatedAt: GENERATED_AT,
    source: { kind: "curated", description: `Curated list of the most commonly impersonated ${ecosystem} packages`, references: SOURCES[ecosystem] },
    hash: datasetHash(names),
    packageNames: names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
  };
}

const check = process.argv.includes("--check");
let mismatches = 0;
if (!check && !existsSync(DIRECTORY)) mkdirSync(DIRECTORY, { recursive: true });
for (const ecosystem of Object.keys(NAMES)) {
  const dataset = buildDataset(ecosystem);
  const file = path.join(DIRECTORY, `${ecosystem}.json`);
  const serialized = `${JSON.stringify(dataset, null, 2)}\n`;
  if (check) {
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (current !== serialized) { console.error(`[typosquat] ${ecosystem}: dataset is stale`); mismatches += 1; }
    continue;
  }
  writeFileSync(file, serialized, "utf8");
  console.log(`[typosquat] ${ecosystem}: ${dataset.packageNames.length} names, ${dataset.hash}`);
}
if (check && mismatches) process.exit(1);
if (check) console.log("[typosquat] datasets are up to date");
