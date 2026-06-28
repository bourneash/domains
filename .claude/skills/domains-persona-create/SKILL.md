---
name: domains-persona-create
description: Create fictional staff personas for a domain site — generates AI face, name, bio, CF email alias, and optionally provisions LinkedIn. Use when onboarding staff personas for americastrikes.com, saveusfarms.com, or broadwayshowgirls.com.
---

# Persona Creation

You are creating fictional staff personas for a brand site. These are AI-generated people publicly associated with the brand.

## Prerequisites

```bash
cd /home/jesse/projects/domains
source .env
cd tools/personas && pip install -e . -q
```

## Create personas

```bash
# 2 reporter personas for americastrikes
persona create --site americastrikes.com --count 2 --role "reporter"

# Check results
persona list --site americastrikes.com
```

## Inspect a persona

```bash
persona show jane-doe --site americastrikes.com
```

## After creation: provision LinkedIn

For each persona, run the LinkedIn provisioner via social-setup:

```bash
social-setup provision-persona jane-doe --site americastrikes.com --platforms linkedin
```

(This drives CloakBrowser through LinkedIn signup using the persona's email + avatar.)

## Gate handling

At LinkedIn SMS verification, CloakBrowser will pause and print:
```
[SMS GATE] Code sent to 6107378479. Write it to /tmp/cloak-gates/linkedin-sms-<domain>.continue
```
Check Jesse's phone and write the code: `echo "123456" > /tmp/cloak-gates/linkedin-sms-<domain>.continue`

## Verify

```bash
persona list --site americastrikes.com
# Should show linkedin: provisioned for each persona
```
