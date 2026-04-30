import requests
import os
import time

os.makedirs("brainrots_imgs", exist_ok=True)

S = requests.Session()
API = "https://stealabrainrot.fandom.com/api.php"

def get_brainrot_pages():
    pages = []
    params = {
        "action": "query",
        "list": "categorymembers",
        "cmtitle": "Category:Brainrots",
        "cmlimit": "500",
        "cmtype": "page",
        "format": "json",
    }
    while True:
        r = S.get(API, params=params).json()
        batch = r["query"]["categorymembers"]
        pages.extend(batch)
        print(f"{len(pages)} brainrots encontrados...")
        if "continue" in r:
            params["cmcontinue"] = r["continue"]["cmcontinue"]
        else:
            break
        time.sleep(0.3)
    return pages

def get_page_image(title):
    params = {
        "action": "query",
        "titles": title,
        "prop": "pageimages",
        "pithumbsize": "500",
        "format": "json",
    }
    r = S.get(API, params=params).json()
    pages = r["query"]["pages"]
    for page in pages.values():
        if "thumbnail" in page:
            return page["thumbnail"]["source"]
    return None

pages = get_brainrot_pages()
print(f"\nTotal: {len(pages)} brainrots. Baixando imagens...")

for page in pages:
    title = page["title"]
    safe_name = title.replace(" ", "_").replace("/", "_") + ".png"
    filepath = os.path.join("brainrots_imgs", safe_name)
    if os.path.exists(filepath):
        continue
    url = get_page_image(title)
    if not url:
        print(f"SEM IMAGEM: {title}")
        continue
    try:
        resp = requests.get(url, timeout=10)
        with open(filepath, "wb") as f:
            f.write(resp.content)
        print(f"OK: {title}")
    except Exception as e:
        print(f"Erro: {title} - {e}")
    time.sleep(0.3)

print("Concluido! Imagens em ./brainrots_imgs/")
