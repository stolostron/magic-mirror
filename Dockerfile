FROM registry.access.redhat.com/ubi9:latest as build

RUN dnf -y module install nodejs:20/minimal && dnf clean -y all

WORKDIR /opt/magic-mirror

COPY package.json package-lock.json ./

RUN npm ci

COPY . .

RUN npm run build


FROM registry.access.redhat.com/ubi9:latest

ENV NODE_ENV=production \
    npm_config_cache=/tmp

RUN dnf -y module install nodejs:20/minimal && dnf install -y npm git-core && dnf clean -y all

# A basic Git configuration to allow Git operations by the Syncer
RUN echo -e "[user]\n\tname = Magic Mirror\n\temail = <>" > /etc/gitconfig

WORKDIR /opt/magic-mirror

COPY package.json package-lock.json ./

RUN npm ci

COPY --from=build /opt/magic-mirror/build ./build

RUN chown -R 1000:1000 "/tmp"

USER 1000
