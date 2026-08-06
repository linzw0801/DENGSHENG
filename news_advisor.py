# -*- coding: utf-8 -*-
"""新闻判断器: 抓取财经快讯 → LLM 判断性质 → 结合量化状态输出操作指引

6 大暴跌方向 (基于 2014-2026 回撤×新闻对照归纳):
  1. 杠杆/流动性收紧  2. 利率预期反转  3. 地缘冲突  4. 单一资产泡沫
  5. 政策突变/监管  6. 疫情/黑天鹅

用法:
  python news_advisor.py [--top N] [--feishu] [--hold 黄金] [--show-raw]
"""
import os, sys, json, time, re
import urllib.request

sys.stdout.reconfigure(encoding='utf-8')
CN_TZ_HOURS = 8

# ============ 新闻源 ============
def fetch_em_news(n=15):
    """东方财富 7x24 快讯"""
    url = ('https://np-listapi.eastmoney.com/comm/web/getNewsByColumns'
           '?client=web&biz=web_724&column=345&order=1&needInteractData=0'
           f'&page_index=1&page_size={n}&req_trace=news_advisor'
           '&fields=code,showTime,title,summary,mediaName,url')
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.eastmoney.com/'})
        r = json.loads(urllib.request.urlopen(req, timeout=15).read().decode('utf-8'))
        items = r.get('data', {}).get('list', [])
        out = []
        for it in items:
            title = it.get('title', '') or ''
            summary = it.get('summary', '') or ''
            text = f"{title} {summary}".strip()
            if text:
                out.append({'time': it.get('showTime', ''), 'text': text[:300], 'src': '东财'})
        return out
    except Exception as e:
        print(f'[警告] 东财快讯失败: {e}')
        return []

def fetch_sina_news(n=15):
    """新浪财经 7x24"""
    url = f'https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size={n}&zhibo_id=152&tag_id=0&dire=f&dpc=1&type=0'
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0', 'Referer': 'https://finance.sina.com.cn'})
        r = json.loads(urllib.request.urlopen(req, timeout=15).read().decode('utf-8'))
        feed = r.get('result', {}).get('data', {}).get('feed', {}).get('list', [])
        out = []
        for it in feed:
            text = it.get('rich_text', '') or ''
            text = re.sub(r'<[^>]+>', ' ', text).strip()
            if text:
                out.append({'time': it.get('create_time', ''), 'text': text[:300], 'src': '新浪'})
        return out
    except Exception as e:
        print(f'[警告] 新浪快讯失败: {e}')
        return []

# ============ LLM 判断 ============
DIRECTIONS = {
    1: '杠杆/流动性收紧 (查配资/去杠杆/收紧流动性)',
    2: '利率预期反转 (美联储加息/美债收益率飙升)',
    3: '地缘冲突/战争 (开战/制裁/冲突升级)',
    4: '单一资产泡沫破裂 (XX见顶/涨幅过大/获利了结)',
    5: '政策突变/监管 (贸易战/关税/监管新规)',
    6: '疫情/黑天鹅 (疫情/封控/灾难)',
}

def glm_analyze(news_text, hold_name, risk_state, score_rank):
    """用 GLM 判断新闻性质, 返回结构化 JSON"""
    key = os.environ.get('GLM_API_KEY', '')
    if not key:
        return {'error': '未设置 GLM_API_KEY'}
    system = """你是ETF动量轮动策略的新闻风控助手。任务：从财经快讯中识别【真正可能影响4个持仓标的】的重大新闻，判断性质，输出操作指引。

【标的映射】判断新闻是否影响持仓标的，严格按此映射：
- 黄金(518880): 美联储/降息加息/美元指数/美债收益率/贵金属/黄金/地缘冲突/通胀/避险
- 纳指(513100): 美股/纳斯达克/美联储/科技股/AI/英伟达/苹果/特斯拉/半导体/加息
- 创业板(159915): 创业板/A股/科技成长/新能源/半导体/小盘股/政策刺激
- 沪深300(510300): A股大盘/上证/宏观/货币政策/经济数据/人民币汇率

【严格标准】只识别满足以下条件的新闻：
1. 直接影响上述4个标的或其背后的市场（美联储、美股、A股、黄金）
2. 属于6大暴跌方向: 1=杠杆/流动性收紧 2=利率预期反转 3=地缘冲突/战争 4=单一资产泡沫破裂(仅指大幅上涨后的见顶信号) 5=政策突变/监管(贸易战/关税/宏观政策) 6=疫情/黑天鹅
3. 事件有实质影响（非个股小事、非行业普通新闻）

【不列入】下列新闻忽略:
- 单个公司/个股的新闻 (如XX公司涨价、XX公司停牌核查、XX新股申购)
- 普通行业动态 (如某金属涨价、某科技公司财报)
- 与4标的无关的宏观琐事
- 娱乐/国际政治琐事 (如某国领导人言论)

只输出JSON:
{"relevant_news":[{"time":"","text":"30字内","direction":1-6或null,"direction_name":"","impact":"利多/利空/中性/不确定","target":"受影响标的","severity":1-5}],
 "overall":{"direction":"主要风险方向","severity":1-5,"summary":"一句话","advice":"结合持仓的具体建议(涉及:是否警惕/是否等信号/是否正常操作)"}}"""
    user = f"""当前持仓: {hold_name}
风控状态: {risk_state}
动量排名: {score_rank}

今日财经快讯(每行一条, 格式[时间]内容):
{news_text}

请严格按准则分析,只输出JSON。"""
    payload = json.dumps({
        'model': 'glm-4-flash',
        'messages': [{'role': 'system', 'content': system}, {'role': 'user', 'content': user}],
        'temperature': 0.2,
        'max_tokens': 1500,
    }).encode()
    req = urllib.request.Request('https://open.bigmodel.cn/api/paas/v4/chat/completions',
                                 data=payload,
                                 headers={'Content-Type': 'application/json', 'Authorization': f'Bearer {key}'})
    for attempt in range(3):
        try:
            r = json.loads(urllib.request.urlopen(req, timeout=30).read().decode('utf-8'))
            content = r.get('choices', [{}])[0].get('message', {}).get('content', '')
            # 提取 JSON
            m = re.search(r'\{.*\}', content, re.DOTALL)
            if m:
                return json.loads(m.group(0))
            return {'error': 'GLM 未返回 JSON', 'raw': content[:200]}
        except Exception as e:
            if attempt < 2:
                time.sleep(2)
            else:
                return {'error': f'GLM 调用失败: {e}'}

# ============ 三条件新闻清仓规则 (基于历史验证) ============
def check_three_conditions(direction, target, hold_code, hold_vol, risk_trig):
    """三条件新闻清仓规则 (2014-2026 验证: 命中3次, 2次真躲1次小误报, 年化+1.05pp)
    ① 新闻属「流动性/去杠杆」(方向1) 或「A股直接利空」(方向5, 贸易战/监管)
    ② 当前持仓是 创业板(159915) 或 沪深300(510300) — 不是黄金/纳指
    ③ 持仓标 vol20 > 25%
    三条件同时满足 且 风控未触发 → 建议清仓
    返回: (是否建议清仓, 原因)
    """
    if risk_trig:
        return False, '风控已触发,按量化信号执行'
    cond1 = direction in (1, 5)
    cond2 = hold_code in ('159915', '510300')
    cond3 = hold_vol is not None and hold_vol > 0.25
    if cond1 and cond2 and cond3:
        return True, '命中三条件(流动性/A股利空+持仓高波动A股+vol>25%)'
    return False, '未命中三条件,不因新闻清仓'

# ============ 主流程 ============
def main():
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument('--top', type=int, default=15, help='抓取新闻条数')
    parser.add_argument('--hold', default='', help='当前持仓 (如: 黄金)')
    parser.add_argument('--risk', default='未触发', help='风控状态')
    parser.add_argument('--rank', default='', help='动量排名')
    parser.add_argument('--hold-vol', default='', help='持仓标 vol20 (如 0.28)')
    parser.add_argument('--feishu', action='store_true', help='推送飞书')
    args = parser.parse_args()

    print('=' * 60)
    print('  ETF 策略新闻判断器')
    print('=' * 60)

    # 1. 抓新闻
    print('\n[1/3] 抓取财经快讯...')
    em = fetch_em_news(args.top)
    sina = fetch_sina_news(args.top)
    all_news = em + sina
    # 去重
    seen = set()
    uniq = []
    for n in all_news:
        k = n['text'][:50]
        if k not in seen:
            seen.add(k)
            uniq.append(n)
    print(f'  抓取 {len(em)} 条东财 + {len(sina)} 条新浪, 去重后 {len(uniq)} 条')
    if not uniq:
        print('[错误] 无新闻')
        return

    # 2. LLM 判断
    print('\n[2/3] LLM 分析新闻性质...')
    hold = args.hold or '未知(请用 --hold 指定)'
    news_text = '\n'.join([f"[{n['time']}] {n['text']}" for n in uniq[:args.top]])
    result = glm_analyze(news_text, hold, args.risk, args.rank)
    if 'error' in result:
        print(f'[错误] {result["error"]}')
        return

    # 3. 输出
    print('\n' + '=' * 60)
    print('  新闻性质分析结果')
    print('=' * 60)
    relevant = result.get('relevant_news', [])
    if relevant:
        print(f'\n⚠️ 相关新闻 ({len(relevant)} 条):')
        for n in relevant:
            sev = '🔴' * n.get('severity', 0)
            print(f"  {sev} [{n.get('direction_name','?')}] {n.get('impact','')} → {n.get('target','')}")
            print(f"     {n.get('text','')[:50]}")
    else:
        print('\n✅ 今日快讯未发现与 6 大暴跌方向相关的新闻')

    ov = result.get('overall', {})
    sev = ov.get('severity', 0)
    print(f"\n📊 整体判断: 风险等级 {sev}/5")
    print(f"   方向: {ov.get('direction','无')}")
    print(f"   总结: {ov.get('summary','')}")
    print(f"   建议: {ov.get('advice','')}")

    # 结合量化状态提示
    print('\n' + '-' * 60)
    print(f'当前持仓: {hold}')
    print(f'风控状态: {args.risk}')

    # 三条件新闻清仓规则
    hold_code = {'创业板': '159915', '沪深300': '510300', '黄金': '518880', '纳指': '513100'}.get(hold, '')
    hold_vol = float(args.hold_vol) if args.hold_vol else None
    risk_trig = args.risk == '触发'
    # 取 GLM 判定的主要方向
    main_dir = None
    for n in relevant:
        if n.get('direction'):
            main_dir = n['direction']
            break
    if main_dir is None and ov.get('direction'):
        # 从方向名反查
        dir_map = {'杠杆': 1, '流动性': 1, '利率': 2, '美联储': 2, '地缘': 3, '战争': 3,
                   '泡沫': 4, '见顶': 4, '政策': 5, '贸易': 5, '监管': 5, '疫情': 6, '黑天鹅': 6}
        for k, v in dir_map.items():
            if k in str(ov.get('direction', '')):
                main_dir = v
                break

    should_clear, reason = check_three_conditions(main_dir, '', hold_code, hold_vol, risk_trig)
    if should_clear:
        print('\n🔴🔴 三条件命中 → 建议考虑提前清仓!')
        print(f'   原因: {reason}')
        print('   操作: 若明天开盘前仍满足, 可清仓切逆回购, 等信号确认再进场')
    else:
        print('\n✅ 三条件未命中 → 不因新闻清仓, 按量化信号执行')
        if reason:
            print(f'   说明: {reason}')
    print(f'   (新闻方向: {main_dir} | 持仓vol20: {hold_vol*100:.0f}% 若提供)')

    # 飞书推送
    if args.feishu:
        webhook = os.environ.get('FEISHU_WEBHOOK_URL', '')
        if webhook:
            lines = []
            if relevant:
                for n in relevant[:5]:
                    lines.append(f"🔴[{n.get('direction_name','?')}] {n.get('text','')[:40]}")
            else:
                lines.append('✅ 今日无重大风险新闻')
            lines.append(f"📊 风险等级: {sev}/5")
            lines.append(f"💡 {ov.get('advice','')[:100]}")
            card = {
                'msg_type': 'interactive',
                'card': {
                    'header': {'title': {'tag': 'plain_text', 'content': f'📰 新闻判断 (风险{sev}/5)'}},
                    'elements': [{'tag': 'markdown', 'content': '\n'.join(lines)}],
                }
            }
            try:
                req = urllib.request.Request(webhook, data=json.dumps(card).encode(),
                                             headers={'Content-Type': 'application/json'})
                urllib.request.urlopen(req, timeout=10)
                print('\n✅ 已推送飞书')
            except Exception as e:
                print(f'\n[警告] 飞书推送失败: {e}')
        else:
            print('\n[提示] 未设置 FEISHU_WEBHOOK_URL, 跳过飞书推送')

if __name__ == '__main__':
    main()
