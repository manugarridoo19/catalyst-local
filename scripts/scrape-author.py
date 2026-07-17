#!/usr/bin/env python3
"""Author Watch scraper — lee el timeline de X del autor seguido usando la
sesión de Brave del usuario (cookies via browser_cookie3) y vuelca los tweets
recientes a un JSON que la ingesta TS consume.

Anti-ban (medidas exigidas por el usuario, ver design doc):
  - Cookies REALES del usuario (auth_token + ct0) → actúa como él.
  - User-Agent de su navegador, timing humano (jitter entre requests).
  - Una sola pasada, sin paralelismo, solo lecturas GraphQL del timeline
    (exactamente lo que carga su navegador al abrir el perfil).
  - Cero acciones de escritura (nada de like/follow/post).
  - Exit 0 SIEMPRE (patrón LaunchAgent) — el motivo real va al stderr/log.

Uso:
  python3 scripts/scrape-author.py <handle> <out.json> [hours]
"""
import sys
import json
import time
import random

HANDLE = sys.argv[1] if len(sys.argv) > 1 else "Couch_Investor"
OUT = sys.argv[2] if len(sys.argv) > 2 else "/tmp/catalyst-author-tweets.json"
HOURS = int(sys.argv[3]) if len(sys.argv) > 3 else 36

# Bearer público del cliente web de X (el mismo que envía tu navegador). No es
# un secreto ni una key personal — identifica a la app web, no al usuario.
BEARER = (
    "AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs"
    "%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA"
)
UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
)
USER_BY_SCREEN_QID = "G3KGOASz96M-Qu0nwmGXNg"
USER_TWEETS_QID = "E3opETHurmVJflFsUBVuUQ"


def die_ok(msg: str):
    """Log a stderr y sale 0 — no queremos popups del LaunchAgent."""
    print(f"[scrape-author] {msg}", file=sys.stderr)
    # Escribe un JSON vacío marcando el fallo para que la ingesta no rompa.
    try:
        with open(OUT, "w") as f:
            json.dump({"handle": HANDLE, "error": msg, "tweets": []}, f)
    except Exception:
        pass
    sys.exit(0)


def main():
    try:
        import browser_cookie3
        import requests
    except Exception as e:
        die_ok(f"missing dep: {e}")

    try:
        cj = browser_cookie3.brave(domain_name="x.com")
    except Exception as e:
        die_ok(f"cookie read failed (Keychain?): {e}")

    jar = {c.name: c.value for c in cj}
    if "auth_token" not in jar or "ct0" not in jar:
        die_ok("no X session in Brave (auth_token/ct0 missing) — log into x.com")

    s = requests.Session()
    for c in cj:
        s.cookies.set(c.name, c.value, domain=c.domain)
    s.headers.update({
        "authorization": f"Bearer {BEARER}",
        "x-csrf-token": jar["ct0"],
        "x-twitter-active-user": "yes",
        "x-twitter-auth-type": "OAuth2Session",
        "x-twitter-client-language": "en",
        "user-agent": UA,
        "referer": f"https://x.com/{HANDLE}",
        "accept": "*/*",
        "content-type": "application/json",
    })

    base_features = {
        "hidden_profile_subscriptions_enabled": True,
        "rweb_tipjar_consumption_enabled": True,
        "responsive_web_graphql_exclude_directive_enabled": True,
        "verified_phone_label_enabled": False,
        "subscriptions_verification_info_is_identity_verified_enabled": True,
        "subscriptions_verification_info_verified_since_enabled": True,
        "highlights_tweets_tab_ui_enabled": True,
        "responsive_web_twitter_article_notes_tab_enabled": True,
        "subscriptions_feature_can_gift_premium": True,
        "creator_subscriptions_tweet_preview_api_enabled": True,
        "responsive_web_graphql_skip_user_profile_image_extensions_enabled": False,
        "responsive_web_graphql_timeline_navigation_enabled": True,
    }

    def graphql(op, qid, variables, features):
        url = f"https://x.com/i/api/graphql/{qid}/{op}"
        params = {
            "variables": json.dumps(variables),
            "features": json.dumps(features),
        }
        return s.get(url, params=params, timeout=25)

    # 1) resolver id
    try:
        r = graphql("UserByScreenName", USER_BY_SCREEN_QID,
                    {"screen_name": HANDLE}, base_features)
        if r.status_code in (401, 403):
            die_ok(f"auth rejected ({r.status_code}) — cookies stale, re-login")
        if r.status_code == 429:
            die_ok("rate limited (429) — backing off, keeping previous brief")
        if r.status_code != 200:
            die_ok(f"UserByScreenName {r.status_code}: {r.text[:120]}")
        uid = r.json()["data"]["user"]["result"]["rest_id"]
    except SystemExit:
        raise
    except Exception as e:
        die_ok(f"resolve id failed: {e}")

    time.sleep(random.uniform(1.6, 3.4))  # timing humano

    tweet_features = dict(base_features)
    tweet_features.update({
        "rweb_video_timestamps_enabled": True,
        "c9s_tweet_anatomy_moderator_badge_enabled": True,
        "responsive_web_edit_tweet_api_enabled": True,
        "graphql_is_translatable_rweb_tweet_is_translatable_enabled": True,
        "view_counts_everywhere_api_enabled": True,
        "longform_notetweets_consumption_enabled": True,
        "responsive_web_twitter_article_tweet_consumption_enabled": True,
        "tweet_awards_web_tipping_enabled": False,
        "freedom_of_speech_not_reach_fetch_enabled": True,
        "standardized_nudges_misinfo": True,
        "tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled": True,
        "longform_notetweets_rich_text_read_enabled": True,
        "longform_notetweets_inline_media_enabled": True,
        "responsive_web_enhance_cards_enabled": False,
        "creator_subscriptions_quote_tweet_preview_enabled": False,
        "articles_preview_enabled": True,
        "communities_web_enable_tweet_community_results_fetch": True,
    })

    try:
        r2 = graphql("UserTweets", USER_TWEETS_QID, {
            "userId": uid, "count": 60, "includePromotedContent": False,
            "withQuickPromoteEligibilityTweetFields": False,
            "withVoice": True, "withV2Timeline": True,
        }, tweet_features)
        if r2.status_code != 200:
            die_ok(f"UserTweets {r2.status_code}: {r2.text[:120]}")
        data = r2.json()
    except SystemExit:
        raise
    except Exception as e:
        die_ok(f"UserTweets failed: {e}")

    cutoff = time.time() - HOURS * 3600
    out = []
    try:
        instrs = (data["data"]["user"]["result"]["timeline_v2"]
                  ["timeline"]["instructions"])
    except Exception as e:
        die_ok(f"unexpected timeline shape: {e}")

    def tweet_results_of(entry):
        # Entrada simple (TimelineTimelineItem): el tweet cuelga de
        # content.itemContent…
        content = entry.get("content", {}) or {}
        item = content.get("itemContent") or {}
        res = (item.get("tweet_results") or {}).get("result")
        if res:
            yield res
        # …pero los HILOS del autor llegan como TimelineTimelineModule
        # (entryId "profile-conversation-…") con cada tweet anidado en
        # content.items[].item.itemContent. Sin esta rama, un hilo entero
        # desaparecía del scrape — ni siquiera entraba el primer tweet.
        for it in content.get("items", []) or []:
            ic = ((it.get("item") or {}).get("itemContent")) or {}
            res = (ic.get("tweet_results") or {}).get("result")
            if res:
                yield res

    seen_ids = set()
    for ins in instrs:
        for entry in ins.get("entries", []):
            for res in tweet_results_of(entry):
                # tweets con visibility wrapper
                if res.get("__typename") == "TweetWithVisibilityResults":
                    res = res.get("tweet", res)
                legacy = res.get("legacy")
                if not legacy:
                    continue
                # En un módulo de conversación pueden venir tweets de OTROS
                # usuarios (replies del hilo): solo nos quedamos los del autor.
                if legacy.get("user_id_str") and legacy["user_id_str"] != uid:
                    continue
                tid = legacy.get("id_str")
                if not tid or tid in seen_ids:
                    continue
                created = legacy.get("created_at")  # "Thu Jul 16 19:58:39 +0000 2026"
                try:
                    ts = time.mktime(time.strptime(created, "%a %b %d %H:%M:%S +0000 %Y"))
                    ts -= time.timezone  # strptime asume local; corrige a UTC
                except Exception:
                    ts = time.time()
                if ts < cutoff:
                    continue
                is_rt = 1 if legacy.get("retweeted_status_result") or \
                    legacy.get("full_text", "").startswith("RT @") else 0
                # texto: notetweet (long) si existe, si no full_text
                note = (res.get("note_tweet") or {}).get("note_tweet_results", {}) \
                    .get("result", {}).get("text")
                text = note or legacy.get("full_text", "")
                seen_ids.add(tid)
                out.append({
                    "tweet_id": tid,
                    "author": HANDLE,
                    "text": text,
                    "created_at": time.strftime(
                        "%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts)),
                    "url": f"https://x.com/{HANDLE}/status/{tid}",
                    "is_retweet": is_rt,
                })

    with open(OUT, "w") as f:
        json.dump({"handle": HANDLE, "tweets": out}, f)
    print(f"[scrape-author] {HANDLE}: {len(out)} tweets (last {HOURS}h) → {OUT}",
          file=sys.stderr)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:
        die_ok(f"unhandled: {e}")
