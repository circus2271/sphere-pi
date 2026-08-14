# ─────────────────────────────────────────────────────────────
#  Образ для тестов уровня "реальный systemd".
#
#  Внутри — настоящий systemd как PID 1, поэтому контейнер нужно
#  запускать так:
#
#    docker build -t sphere-systemd-test -f playRPI/test/deploy/docker/Dockerfile .
#    docker run -d --name sphere-systemd-test-run \
#      --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
#      sphere-systemd-test
#
#  Контекст сборки — КОРЕНЬ репозитория (sphere-pi/), не playRPI/.
#  Всё это делает за тебя systemd.test.js — руками собирать не нужно.
#
#  Что здесь воспроизводится с устройства (пути и пользователь — один в один,
#  без симлинков-подстановок, поэтому проверяются заодно и права доступа):
#    spherepi-peremena                                     — владелец процесса
#    /home/spherepi-peremena/sphere/sphere-pi/playRPI      — WorkingDirectory юнита
#    /home/spherepi-peremena/sphere/sphere-pi              — REPO_DIR в update.mjs
#    /home/spherepi-peremena/origin.git                    — bare-репозиторий вместо GitHub
#    /etc/systemd/system/sphere-player.service → симлинк в репозиторий
# ─────────────────────────────────────────────────────────────
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    container=docker

RUN apt-get update && apt-get install -y --no-install-recommends \
      systemd systemd-sysv dbus \
      nodejs npm git sudo procps ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Debian кладёт бинарь то как node, то как nodejs — юнит ждёт /usr/bin/node.
RUN [ -x /usr/bin/node ] || ln -s /usr/bin/nodejs /usr/bin/node
RUN node --version && npm --version && git --version

# ── Глушим юниты, которым в контейнере делать нечего ──────────
# systemctl mask при сборке недоступен (демон не запущен), поэтому
# симлинки на /dev/null создаём руками — это ровно то же самое.
RUN for unit in \
      getty.target \
      console-getty.service \
      getty@tty1.service \
      systemd-udevd.service \
      systemd-udevd-control.socket \
      systemd-udevd-kernel.socket \
      systemd-udev-trigger.service \
      systemd-logind.service \
      systemd-remount-fs.service \
      systemd-journald-audit.socket \
      dev-hugepages.mount \
      sys-fs-fuse-connections.mount \
    ; do ln -sf /dev/null "/etc/systemd/system/$unit"; done

# ── Пользователь и sudo строго на две команды ────────────────
# Пользователь и путь — ровно как на устройстве, без симлинков-подстановок:
# так тест проверяет заодно и права доступа (дизлайк переписывает .txt).
# Оба пути к systemctl перечислены намеренно: update.mjs зовёт
# `sudo /bin/systemctl`, а sudoers сверяет строку буквально — правило на
# /usr/bin/systemctl такой вызов не покроет, хотя /bin и симлинк на /usr/bin.
RUN useradd -m -s /bin/bash spherepi-peremena \
 && printf '%s\n' \
      'spherepi-peremena ALL=(root) NOPASSWD: /usr/bin/systemctl daemon-reload, /usr/bin/systemctl restart sphere-player, /bin/systemctl daemon-reload, /bin/systemctl restart sphere-player' \
      > /etc/sudoers.d/sphere-player \
 && chmod 0440 /etc/sudoers.d/sphere-player \
 && visudo -c -f /etc/sudoers.d/sphere-player

# ── Код приложения ───────────────────────────────────────────
COPY --chown=spherepi-peremena:spherepi-peremena playRPI /home/spherepi-peremena/sphere/sphere-pi/playRPI
COPY --chown=spherepi-peremena:spherepi-peremena deploy /home/spherepi-peremena/sphere/sphere-pi/deploy
COPY --chown=spherepi-peremena:spherepi-peremena package.json package-lock.json .gitignore /home/spherepi-peremena/sphere/sphere-pi/

# КЛЮЧЕВОЕ: подменяем плеер фейком ПОД ТЕМ ЖЕ ИМЕНЕМ файла.
# Настоящий плеер здесь не выживет (нет звуковой карты, нет
# _playerConfig.js), а юнит менять нельзя — он часть того, что тестируем.
# Фейк отвечает на SIGUSR2 ровно так же, как настоящий.
RUN cp /home/spherepi-peremena/sphere/sphere-pi/playRPI/test/deploy/fixtures/fake-node-sound-player-production.js \
       /home/spherepi-peremena/sphere/sphere-pi/playRPI/node-sound-player-production.js \
 && chown spherepi-peremena:spherepi-peremena /home/spherepi-peremena/sphere/sphere-pi/playRPI/node-sound-player-production.js

USER spherepi-peremena
WORKDIR /home/spherepi-peremena/sphere/sphere-pi

# Настоящий npm ci — тот же, что update.mjs зовёт при смене lock-файла.
# Ставим в КОРНЕ репозитория: package.json теперь там, и оттуда зависимости
# видны и плееру в playRPI, и скрипту в deploy (Node ищет node_modules вверх).
RUN npm ci --no-audit --no-fund

# ── git: рабочая копия + bare-"origin" внутри контейнера ──────
# Ветка master — значение UPDATE_BRANCH по умолчанию в update.mjs.
RUN git config --global user.email "docker-test@sphere.local" \
 && git config --global user.name "sphere docker test" \
 && git config --global --add safe.directory '*' \
 && cd /home/spherepi-peremena/sphere/sphere-pi \
 && git init -q -b master \
 && git add -A \
 && git commit -q -m "baseline (docker test image)" \
 && git init -q --bare -b master /home/spherepi-peremena/origin.git \
 && git remote add origin /home/spherepi-peremena/origin.git \
 && git push -q origin master \
 && git branch -q --set-upstream-to=origin/master master

# ── Юнит: симлинк в репозиторий + ручной enable ──────────────
# systemctl enable при сборке не работает (нет живого демона на шине),
# поэтому .wants-симлинк создаём сами — результат идентичный.
USER root
RUN ln -s /home/spherepi-peremena/sphere/sphere-pi/deploy/sphere-player.service \
          /etc/systemd/system/sphere-player.service \
 && mkdir -p /etc/systemd/system/multi-user.target.wants \
 && ln -s /etc/systemd/system/sphere-player.service \
          /etc/systemd/system/multi-user.target.wants/sphere-player.service

WORKDIR /
STOPSIGNAL SIGRTMIN+3
ENTRYPOINT ["/sbin/init"]
