#!/usr/bin/env python3
import json
import os
import time

FILES = ['nao_spam.json', 'nao_spam_teste.json', 'spam.json', 'spam_teste.json']

def get_status():
    os.system('clear' if os.name == 'posix' else 'cls')
    print("=" * 60)
    print("      MONITORAMENTO EM TEMPO REAL - EXPANSÃO 30K      ")
    print("=" * 60)
    print(f"Horário: {time.strftime('%H:%M:%S')}\n")

    grand_total_trans = 0
    grand_total_needed = 4 * 19700 # ~78.800

    for fn in FILES:
        cache_fn = f"cache_trans_{fn}"
        if os.path.exists(cache_fn):
            try:
                with open(cache_fn, 'r', encoding='utf-8') as f:
                    c = json.load(f)
                es_cnt = len(c.get('es', {}))
                en_cnt = len(c.get('en', {}))
                tot = es_cnt + en_cnt
                grand_total_trans += tot
                
                pct_es = round((es_cnt / 9851) * 100, 1)
                pct_en = round((en_cnt / 9849) * 100, 1)
                pct_tot = round((tot / 19700) * 100, 1)

                status_label = "🟢 EM ANDAMENTO" if tot < 19700 else "✅ CONCLUÍDO"
                print(f"[{status_label}] {fn}")
                print(f"   🇪🇸 Espanhol: {es_cnt:>5,}/9.851 ({pct_es:>5.1f}%) [{'=' * int(pct_es // 5):<20}]")
                print(f"   🇬🇧 Inglês:   {en_cnt:>5,}/9.849 ({pct_en:>5.1f}%) [{'=' * int(pct_en // 5):<20}]")
                print(f"   📊 Total:    {tot:>5,}/19.700 ({pct_tot:>5.1f}%)\n")
            except Exception:
                print(f"[⏳ LENDO...] {fn}\n")
        else:
            print(f"[⏳ NA FILA...] {fn}\n")

    overall_pct = round((grand_total_trans / grand_total_needed) * 100, 1)
    print("=" * 60)
    print(f"PROGRESSO GERAL: {grand_total_trans:,}/{grand_total_needed:,} ({overall_pct}%)")
    print(f"[{'=' * int(overall_pct // 5):<20}]")
    print("=" * 60)
    print("(Pressione Ctrl+C para sair do monitor)")

if __name__ == '__main__':
    try:
        while True:
            get_status()
            time.sleep(2)
    except KeyboardInterrupt:
        pass
