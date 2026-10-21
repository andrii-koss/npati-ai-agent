#!/bin/sh
# Composer must use the same PHP and extensions as project commands.
exec /usr/local/bin/php /usr/bin/composer.phar "$@"
