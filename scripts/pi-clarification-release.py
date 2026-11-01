#!/usr/bin/env python3
"""Release only the isolated, send-locked PI preview; never restart the main Luma app."""
import base64,json,os,pathlib,subprocess,sys
os.umask(0o077)
ROOT=pathlib.Path(__file__).resolve().parent.parent
HOST=os.environ.get('PI_PREVIEW_HOST','pi-clarification-test.deepspring.co')
NS=os.environ.get('PI_PREVIEW_NAMESPACE','cloud-dev')
NAME='reza-luma-pi-test'
KUBE=['kubectl']
SAFE_KEYS=['PATH','HOME','USER','LOGNAME','SHELL','LANG','TZ','TMPDIR','NODE_EXTRA_CA_CERTS','SSL_CERT_FILE','HTTP_PROXY','HTTPS_PROXY','NO_PROXY','PASSWORD','APP_PASSWORD','JWT_SECRET','KUBECONFIG','PM2_HOME']
SAFE_ENV={k:v for k,v in os.environ.items() if k in SAFE_KEYS}
def get(*args):return json.loads(subprocess.check_output(KUBE+list(args)+['-o','json']))
def prepare():
    import secrets
    from urllib.parse import urlparse
    if urlparse('https://'+HOST).hostname!=HOST or '/' in HOST:raise RuntimeError('Invalid preview hostname')
    pod=get('-n',NS,'get','pod',os.environ['HOSTNAME'])
    secret=get('-n','production','get','secret','pi-mailroom-email')
    config={k:base64.b64decode(v).decode() for k,v in secret['data'].items() if k.startswith('MAILROOM_EMAIL_')}
    if config.get('MAILROOM_EMAIL_SENDER','').lower()!='admin@proimagetx.ai':raise RuntimeError('Cluster credential mailbox mismatch')
    private=pathlib.Path('/home/.agentic/secrets/luma-pi-gmail-federation.json');private.write_text(json.dumps(config));private.chmod(0o600)
    previous={}
    if (ROOT/'.env').exists():
        for line in (ROOT/'.env').read_text().splitlines():
            if '=' in line:
                k,v=line.split('=',1)
                try:previous[k]=json.loads(v)
                except ValueError:previous[k]=v
    password=os.environ.get('PASSWORD') or previous.get('PASSWORD')
    if not password:raise RuntimeError('Existing Luma owner password is required')
    settings={**{k:v for k,v in previous.items() if k.startswith(('PI_REASONER_','PI_ANTHROPIC_','PI_INVESTIGATOR_'))},'PASSWORD':password,'JWT_SECRET':previous.get('JWT_SECRET') or secrets.token_hex(32),'HOST':'0.0.0.0','API_PORT':'19091','WEB_PORT':'19075','LUMA_WEB_URL':'https://'+HOST,'PI_CLARIFICATION_ENABLED':'true','PI_CLARIFICATION_MODE':'draft_only','PI_CLARIFICATION_SEND_LOCK':'true','PI_GMAIL_MAILBOX':'admin@proimagetx.ai','PI_GMAIL_POLL_SECONDS':'120','PI_CREDENTIAL_ENCRYPTION_KEY':previous.get('PI_CREDENTIAL_ENCRYPTION_KEY') or secrets.token_hex(32),'PI_GMAIL_FEDERATION_CREDENTIALS_FILE':str(private),'PI_REASONER_PROVIDER':previous.get('PI_REASONER_PROVIDER','json_http'),'PI_GMAIL_ALLOW_DRAFT_WRITES':'false'}
    target=ROOT/'.env';target.write_text('\n'.join(k+'='+json.dumps(v) for k,v in settings.items())+'\n');target.chmod(0o600)
    selector={'statefulset.kubernetes.io/pod-name':pod['metadata']['name']}
    service={'apiVersion':'v1','kind':'Service','metadata':{'name':NAME,'namespace':NS,'labels':{'app.kubernetes.io/component':'pi-clarification-test'}},'spec':{'selector':selector,'ports':[{'name':'api','port':19091,'targetPort':19091},{'name':'web','port':19075,'targetPort':19075}]}}
    ingress={'apiVersion':'networking.k8s.io/v1','kind':'Ingress','metadata':{'name':NAME,'namespace':NS,'annotations':{'nginx.ingress.kubernetes.io/force-ssl-redirect':'true','nginx.ingress.kubernetes.io/proxy-read-timeout':'3600','nginx.ingress.kubernetes.io/proxy-buffering':'off','nginx.ingress.kubernetes.io/proxy-body-size':'20m'}},'spec':{'ingressClassName':'nginx','tls':[{'hosts':[HOST],'secretName':'wildcard-ds-ssl-secret'}],'rules':[{'host':HOST,'http':{'paths':[{'path':'/api','pathType':'Prefix','backend':{'service':{'name':NAME,'port':{'name':'api'}}}},{'path':'/','pathType':'Prefix','backend':{'service':{'name':NAME,'port':{'name':'web'}}}}]}}]}}
    (ROOT/'data/logs').mkdir(parents=True,exist_ok=True)
    state_file=ROOT/'data/ui-state.json'
    state=json.loads(state_file.read_text()) if state_file.exists() else {}
    if not state.get('activeWorkspace') or not pathlib.Path(state['activeWorkspace']).is_dir():
        state.update({'activeWorkspace':str(ROOT),'manualWorkspaces':list(dict.fromkeys(state.get('manualWorkspaces',[])+[str(ROOT)]))});state_file.write_text(json.dumps(state))
    policy={'apiVersion':'networking.k8s.io/v1','kind':'NetworkPolicy','metadata':{'name':NAME,'namespace':NS},'spec':{'podSelector':{'matchLabels':{key:pod['metadata']['labels'][key] for key in ['app.kubernetes.io/instance','app.kubernetes.io/name']}},'policyTypes':['Ingress'],'ingress':[{'from':[{'namespaceSelector':{'matchLabels':{'kubernetes.io/metadata.name':'ingress-nginx'}},'podSelector':{'matchLabels':{'app.kubernetes.io/component':'controller','app.kubernetes.io/name':'ingress-nginx'}}}],'ports':[{'port':19075,'protocol':'TCP'},{'port':19091,'protocol':'TCP'}]}]}}
    (ROOT/'data/pi-preview-manifests.json').write_text(json.dumps({'apiVersion':'v1','kind':'List','items':[service,ingress,policy]}))
    print('Prepared private read-only credentials, isolated ports, and preview manifests. No secret values displayed.')
def publish():
    subprocess.run([str(ROOT/'node_modules/.bin/pm2'),'startOrReload',str(ROOT/'scripts/pi-clarification-preview.config.cjs'),'--update-env'],env=SAFE_ENV,check=True)
    subprocess.run([str(ROOT/'node_modules/.bin/pm2'),'save'],env=SAFE_ENV,check=True)
    dump=pathlib.Path(os.environ.get('PM2_HOME',str(pathlib.Path.home()/'.pm2')))/'dump.pm2'
    if dump.exists():dump.chmod(0o600)
    network()
    print('Test URL: https://'+HOST+' — use the existing Luma owner password. All sending is locked.')
def network():
    subprocess.run(KUBE+['apply','-f',str(ROOT/'data/pi-preview-manifests.json')],check=True)

if __name__=='__main__':
    try:
        if sys.argv[1]=='prepare':prepare()
        elif sys.argv[1]=='publish':publish()
        elif sys.argv[1]=='network':network()
        else:raise RuntimeError('Expected prepare or publish')
    except Exception as error:
        print('PI preview release failed ('+type(error).__name__+'). No credentials displayed.',file=sys.stderr);sys.exit(1)
