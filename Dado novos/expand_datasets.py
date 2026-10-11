import json
import os
import re
import time
import urllib.request
import urllib.parse
from concurrent.futures import ThreadPoolExecutor

class DDGTranslator:
    def __init__(self):
        self.vqd = self.refresh_vqd()

    def refresh_vqd(self):
        for _ in range(5):
            try:
                req = urllib.request.Request(
                    'https://duckduckgo.com/?q=translate',
                    headers={'User-Agent': 'Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:120.0) Gecko/20100101 Firefox/120.0'}
                )
                html = urllib.request.urlopen(req, timeout=10).read().decode('utf-8')
                m = re.search(r'vqd=([\d\-]+)', html) or re.search(r'vqd=([a-zA-Z0-9\-_]+)', html)
                if m:
                    return m.group(1)
            except Exception as e:
                time.sleep(1)
        return "4-67714891594710946742176725565691073303"

    def translate_batch(self, texts, target_lang='en'):
        if not texts:
            return []
        
        # Numera os itens para preservar delimitação
        numbered_lines = [f"{i+1}. {txt.replace('\n', ' ')}" for i, txt in enumerate(texts)]
        payload = "\n".join(numbered_lines)

        for attempt in range(4):
            url = f"https://duckduckgo.com/translation.js?query=translate&vqd={self.vqd}&to={target_lang}"
            req = urllib.request.Request(
                url,
                data=payload.encode('utf-8'),
                headers={'User-Agent': 'Mozilla/5.0', 'Content-Type': 'text/plain; charset=utf-8'}
            )
            try:
                with urllib.request.urlopen(req, timeout=12) as resp:
                    data = json.loads(resp.read().decode('utf-8'))
                    translated = data.get('translated', '')
                    
                    # Divide pelas numerações "1. ", "2. ", etc.
                    parts = re.split(r'\s*\b\d+\.\s*', translated)
                    parts = [p.strip() for p in parts if p.strip()]
                    
                    if len(parts) == len(texts):
                        return parts
                    elif len(parts) > len(texts):
                        return parts[:len(texts)]
                    else:
                        # Se veio incompleto, tenta fallback individual para os que faltam
                        pass
            except Exception as e:
                time.sleep(1 + attempt)
                self.vqd = self.refresh_vqd()

        # Fallback individual caso o batch falhe
        results = []
        for txt in texts:
            results.append(self.translate_single(txt, target_lang))
        return results

    def translate_single(self, text, target_lang='en'):
        clean = text.replace('\n', ' ')
        for attempt in range(3):
            url = f"https://duckduckgo.com/translation.js?query=translate&vqd={self.vqd}&to={target_lang}"
            req = urllib.request.Request(
                url,
                data=clean.encode('utf-8'),
                headers={'User-Agent': 'Mozilla/5.0', 'Content-Type': 'text/plain; charset=utf-8'}
            )
            try:
                with urllib.request.urlopen(req, timeout=8) as resp:
                    data = json.loads(resp.read().decode('utf-8'))
                    return data.get('translated', clean)
            except Exception:
                time.sleep(1)
                self.vqd = self.refresh_vqd()
        return clean

def process_file(filename, translator):
    print(f"\n==========================================")
    print(f"Iniciando processamento de: {filename}")
    print(f"==========================================")

    cache_file = f"cache_trans_{filename}"
    cache = {}
    if os.path.exists(cache_file):
        try:
            with open(cache_file, 'r', encoding='utf-8') as f:
                cache = json.load(f)
            print(f"Cache carregado: {len(cache.get('es', {}))} em ES, {len(cache.get('en', {}))} em EN")
        except Exception:
            cache = {'es': {}, 'en': {}}
    else:
        cache = {'es': {}, 'en': {}}

    with open(filename, 'r', encoding='utf-8') as f:
        data = json.load(f)

    # Separa por idioma
    pt_items = [d for d in data if d.get('idioma') == 'Português']
    es_items = [d for d in data if d.get('idioma') == 'Espanhol']
    en_items = [d for d in data if d.get('idioma') == 'Inglês']

    # 1. Ajusta Português para exatamente 10.000
    pt_final = pt_items[:10000]

    needed_es = 10000 - len(es_items)
    needed_en = 10000 - len(en_items)

    print(f"Atuais -> PT: {len(pt_items)}, ES: {len(es_items)}, EN: {len(en_items)}")
    print(f"Necessário traduzir -> ES: {needed_es}, EN: {needed_en}")

    # Seleciona itens de PT como base para tradução
    to_translate_base = pt_final[:max(needed_es, needed_en)]

    # Tradução para Espanhol
    es_translated_items = []
    batch_size = 8
    
    print("\n--- Traduzindo para Espanhol ---")
    es_needed_subset = to_translate_base[:needed_es]
    
    last_save = time.time()
    for i in range(0, len(es_needed_subset), batch_size):
        chunk = es_needed_subset[i:i+batch_size]
        uncached = [item for item in chunk if item['conteudo'] not in cache['es']]
        
        if uncached:
            texts = [item['conteudo'] for item in uncached]
            translated_texts = translator.translate_batch(texts, target_lang='es')
            for orig, trans in zip(uncached, translated_texts):
                cache['es'][orig['conteudo']] = trans

        for item in chunk:
            new_item = dict(item)
            new_item['idioma'] = 'Espanhol'
            new_item['conteudo'] = cache['es'].get(item['conteudo'], item['conteudo'])
            es_translated_items.append(new_item)

        if i % 200 == 0 or i + batch_size >= len(es_needed_subset):
            pct = round((len(es_translated_items) / needed_es) * 100, 1)
            print(f"[{filename}] ES progresso: {len(es_translated_items)}/{needed_es} ({pct}%)")
            
        if time.time() - last_save > 30:
            with open(cache_file, 'w', encoding='utf-8') as f:
                json.dump(cache, f, ensure_ascii=False)
            last_save = time.time()

    # Salva cache
    with open(cache_file, 'w', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False)

    # Tradução para Inglês
    en_translated_items = []
    print("\n--- Traduzindo para Inglês ---")
    en_needed_subset = to_translate_base[:needed_en]

    for i in range(0, len(en_needed_subset), batch_size):
        chunk = en_needed_subset[i:i+batch_size]
        uncached = [item for item in chunk if item['conteudo'] not in cache['en']]
        
        if uncached:
            texts = [item['conteudo'] for item in uncached]
            translated_texts = translator.translate_batch(texts, target_lang='en')
            for orig, trans in zip(uncached, translated_texts):
                cache['en'][orig['conteudo']] = trans

        for item in chunk:
            new_item = dict(item)
            new_item['idioma'] = 'Inglês'
            new_item['conteudo'] = cache['en'].get(item['conteudo'], item['conteudo'])
            en_translated_items.append(new_item)

        if i % 200 == 0 or i + batch_size >= len(en_needed_subset):
            pct = round((len(en_translated_items) / needed_en) * 100, 1)
            print(f"[{filename}] EN progresso: {len(en_translated_items)}/{needed_en} ({pct}%)")

        if time.time() - last_save > 30:
            with open(cache_file, 'w', encoding='utf-8') as f:
                json.dump(cache, f, ensure_ascii=False)
            last_save = time.time()

    # Salva cache final
    with open(cache_file, 'w', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False)

    # Junta tudo: 10k PT, 10k ES, 10k EN
    final_es = (es_items + es_translated_items)[:10000]
    final_en = (en_items + en_translated_items)[:10000]
    final_list = pt_final + final_es + final_en

    # Reindexa IDs de 1 a 30.000
    for idx, item in enumerate(final_list, start=1):
        item['id'] = idx

    print(f"\nSalvando resultado final em {filename}...")
    print(f"Contagem final: Total={len(final_list)} | PT={len(pt_final)} | ES={len(final_es)} | EN={len(final_en)}")

    # Salva no arquivo final
    with open(filename, 'w', encoding='utf-8') as f:
        json.dump(final_list, f, ensure_ascii=False, indent=2)

    print(f"Concluído com sucesso para {filename}!\n")

def main():
    translator = DDGTranslator()
    files = ['nao_spam.json', 'nao_spam_teste.json', 'spam.json', 'spam_teste.json']
    for fname in files:
        process_file(fname, translator)

if __name__ == '__main__':
    main()
