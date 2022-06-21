FROM registry.access.redhat.com/ubi9:latest as build

RUN dnf install -y npm && dnf clean -y all

WORKDIR /opt/magic-mirror

COPY package.json package-lock.json ./

RUN npm install

COPY . .

RUN npm run build


FROM registry.access.redhat.com/ubi9:latest

ENV NODE_ENV=production

RUN dnf install -y npm git-core && dnf clean -y all

# A basic Git configuration to allow Git operations by the Syncer
RUN echo -e "[user]\n\tname = Magic Mirror\n\temail = <>" > /etc/gitconfig

WORKDIR /opt/magic-mirror

COPY package.json package-lock.json ./

RUN npm install

COPY --from=build /opt/magic-mirror/build ./build

USER 1000
