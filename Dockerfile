FROM registry.access.redhat.com/ubi10-minimal:latest AS build

RUN microdnf -y install nodejs24 nodejs24-npm && microdnf clean -y all

RUN ln -sf /usr/bin/node-24 /usr/bin/node \
    && ln -sf /usr/bin/npm-24 /usr/bin/npm \
    && ln -sf /usr/bin/npx-24 /usr/bin/npx

WORKDIR /opt/magic-mirror

COPY package.json package-lock.json ./

RUN npm ci

COPY . .

RUN npm run build


FROM registry.access.redhat.com/ubi10-minimal:latest

ENV NODE_ENV=production \
    npm_config_cache=/tmp

RUN microdnf install -y nodejs24 nodejs24-npm git-core && microdnf clean -y all

RUN ln -sf /usr/bin/node-24 /usr/bin/node \
    && ln -sf /usr/bin/npm-24 /usr/bin/npm \
    && ln -sf /usr/bin/npx-24 /usr/bin/npx

# A basic Git configuration to allow Git operations by the Syncer
RUN echo -e "[user]\n\tname = Magic Mirror\n\temail = <>" > /etc/gitconfig

WORKDIR /opt/magic-mirror

COPY package.json package-lock.json ./

RUN npm ci

COPY --from=build /opt/magic-mirror/build ./build

RUN chown -R 1001:1001 "/tmp"

USER 1001
