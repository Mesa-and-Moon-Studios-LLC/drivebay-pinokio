# Drivebay Enterprise cloud API (self-hosted). Build from the server/ folder:
#   docker build -f enterprise/Dockerfile -t drivebay-enterprise server
FROM php:8.3-apache

RUN a2enmod headers rewrite \
 && apt-get update && apt-get install -y --no-install-recommends libsqlite3-dev libcurl4-openssl-dev \
 && docker-php-ext-install pdo_sqlite \
 && rm -rf /var/lib/apt/lists/*
# ext-sodium and curl are already in the official image.

COPY cloud-api/api /var/www/html/api
COPY cloud-api/lib /var/www/html/lib
COPY enterprise/license-gate.php /opt/drivebay/license-gate.php
COPY enterprise/enterprise-license.php /var/www/html/api/enterprise-license.php
COPY enterprise/entrypoint.sh /usr/local/bin/drivebay-entrypoint
COPY enterprise/php-drivebay.ini /usr/local/etc/php/conf.d/drivebay.ini
# The hosted-service pieces are not part of a self-host: payments, minting and the public license endpoint.
RUN rm -f /var/www/html/api/webhook.php /var/www/html/api/license-admin.php /var/www/html/api/license.php \
 && date +%s > /var/www/html/BUILD_TS \
 && chmod +x /usr/local/bin/drivebay-entrypoint \
 && printf '<Directory /var/www/html/lib>\n  Require all denied\n</Directory>\n<Files "BUILD_TS">\n  Require all denied\n</Files>\n' > /etc/apache2/conf-enabled/drivebay-deny.conf

VOLUME ["/data"]
EXPOSE 80
ENTRYPOINT ["drivebay-entrypoint"]
CMD ["apache2-foreground"]
