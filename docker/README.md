# Docker

The root `docker-compose.yml` is the only local entry point for milestone one.
Application images are defined next to their apps. OmniRoute runs from the
official versioned image `diegosouzapw/omniroute:3.8.49`; the matching pinned
source remains in `vendor/omniroute` for audit and controlled upgrades.
