#!/usr/bin/env python3
"""Lab 6 CKA — evaluador read-only de CNI, Services, DNS y NetworkPolicy.

Version 1.0.0. Dependencias: Python 3.9+, kubectl y credenciales válidas.
El monitor solo consulta Kubernetes y ejecuta pruebas de red dentro de Pods existentes.
NO crea, parchea ni elimina recursos. No almacena tokens ni kubeconfigs.
"""
import argparse
import datetime as dt
import json
import os
import pathlib
import subprocess
import sys
import time
from contextlib import contextmanager

VERSION = '1.0.0'
HERE = pathlib.Path.cwd()
REPORT = HERE / 'reporte_lab6.json'
PIDFILE = HERE / '.evaluar_lab6.pid'
STOPFILE = HERE / '.evaluar_lab6.stop'
LOGFILE = HERE / 'evaluar_lab6_monitor.log'
LOCKDIR = HERE / '.evaluar_lab6.lock'
POLL = 8
TIMEOUT = 8

TASKS = {
    1: ('Línea base de red', 10),
    2: ('Conectividad Pod-to-Pod y Service', 15),
    3: ('Resolución DNS', 10),
    4: ('Diagnóstico de red', 10),
    5: ('Falla y recuperación de CoreDNS', 15),
    6: ('Falla y recuperación del Service', 15),
    7: ('NetworkPolicy: bloqueo y excepción', 15),
    8: ('Recuperación y limpieza', 10),
}
# id, task, points, phase (max phase when evaluated), description.
CHECKS = [
 ('nodes',1,3,'pre','Nodos Ready y con InternalIP'),
 ('proxy',1,2,'pre','kube-proxy con DaemonSet disponible'),
 ('coredns',1,2,'pre','CoreDNS con Deployment disponible'),
 ('dns_svc',1,3,'pre','Service kube-dns y endpoints DNS listos'),
 ('namespace',2,2,'pre','Namespace net-lab presente'),
 ('web',2,3,'pre','Deployment web con dos réplicas disponibles'),
 ('web_svc',2,3,'pre','Service web-svc ClusterIP/80 correcto'),
 ('web_eps',2,3,'pre','Dos backends Ready en EndpointSlices'),
 ('client',2,2,'pre','Pod net-client Ready'),
 ('direct',2,2,'pre','HTTP hacia IP del backend desde net-client'),
 ('dnsclient',3,2,'pre','Pod dns-client Ready'),
 ('dns_k8s',3,2,'pre','DNS de kubernetes.default funciona'),
 ('dns_web',3,3,'pre','DNS de web-svc coincide con ClusterIP'),
 ('resolv',3,3,'pre','resolv.conf usa la IP de kube-dns'),
 ('selector',4,3,'pre','Selector de web-svc coincide con Pods'),
 ('proxy_ready',4,3,'pre','DaemonSet kube-proxy completamente disponible'),
 ('baseline_http',4,4,'pre','web-svc responde HTTP y DNS funciona'),
 ('dns_bad',5,5,'dns_fault','Selector DNS alterado observado'),
 ('dns_noeps',5,3,'dns_fault','DNS sin endpoints Ready observado'),
 ('dns_restored',5,3,'dns_fixed','Selector DNS restaurado tras la falla'),
 ('dns_eps_restored',5,2,'dns_fixed','Endpoints DNS recuperados'),
 ('dns_lookup_restored',5,2,'dns_fixed','Resolución DNS recuperada'),
 ('svc_bad',6,4,'svc_fault','Selector web-svc alterado observado'),
 ('svc_noeps',6,3,'svc_fault','web-svc sin endpoints Ready observado'),
 ('svc_direct',6,2,'svc_fault','Conectividad directa permanece funcional'),
 ('svc_restored',6,2,'svc_fixed','Selector web-svc reparado'),
 ('svc_eps_restored',6,2,'svc_fixed','Endpoints web-svc recuperados'),
 ('svc_http_restored',6,2,'svc_fixed','Service HTTP recuperado'),
 ('deny_policy',7,4,'policy_deny','deny-web-ingress restringe ingress a web'),
 ('blocked',7,3,'policy_deny','HTTP bloqueado con NetworkPolicy activa'),
 ('allow_policy',7,4,'policy_allow','allow-web-from-client aplica mínimo acceso TCP/80'),
 ('allow_http',7,4,'policy_allow','HTTP permitido desde cliente etiquetado'),
 ('final_nodes',8,2,'final','Nodos continúan Ready'),
 ('final_dns',8,2,'final','kube-dns conserva el selector original'),
 ('final_system',8,2,'final','CoreDNS y kube-proxy saludables'),
 ('cleanup',8,4,'cleanup','net-lab eliminado tras las recuperaciones'),
]
PHASES = ['pre','dns_fault','dns_fixed','svc_fault','svc_fixed','policy_deny','policy_allow','final','cleanup']
CHECK_BY_ID = {a[0]: a for a in CHECKS}
assert sum(v[1] for v in TASKS.values()) == 100
assert sum(c[2] for c in CHECKS) == 100
assert all(sum(c[2] for c in CHECKS if c[1] == t) == p for t,(_,p) in TASKS.items())


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='seconds')


def run(args, timeout=TIMEOUT):
    try:
        p = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
                           encoding='utf-8', errors='replace')
        return (p.returncode, p.stdout, p.stderr)
    except subprocess.TimeoutExpired:
        return (124, '', 'Tiempo de espera agotado')
    except OSError as e:
        return (127, '', str(e))


def kube(*args, timeout=TIMEOUT):
    return run(['kubectl', '--request-timeout=6s', *args], timeout=timeout)


def get(kind, name=None, namespace=None):
    args=['get',kind]
    if name: args.append(name)
    if namespace: args.extend(['-n',namespace])
    args.extend(['-o','json'])
    rc,out,err=kube(*args)
    if rc != 0:
        if 'NotFound' in err or 'not found' in err or 'No resources found' in err:
            return None
        return {'_error': err.strip()[:180] or f'kubectl exit {rc}'}
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return {'_error':'Respuesta JSON inválida; comprobar kubectl'}


def obj_bad(o):
    return isinstance(o,dict) and '_error' in o


def obj_get(o,*keys,default=None):
    for k in keys:
        if not isinstance(o,dict):return default
        o=o.get(k)
    return default if o is None else o


def ready_pod(p):
    return obj_get(p,'status','phase') == 'Running' and any(
        c.get('type')=='Ready' and c.get('status')=='True'
        for c in obj_get(p,'status','conditions',default=[]))


def ready_nodes(s):
    nodes=s.get('nodes')
    if not isinstance(nodes,dict) or obj_bad(nodes):return False
    items=nodes.get('items',[])
    if not {'cka-control','cka-worker1','cka-worker2'}.issubset({obj_get(n,'metadata','name') for n in items}):return False
    for n in items:
        cond={x.get('type'):x.get('status') for x in obj_get(n,'status','conditions',default=[])}
        ips=[x.get('address') for x in obj_get(n,'status','addresses',default=[]) if x.get('type')=='InternalIP']
        if cond.get('Ready')!='True' or not ips:return False
    return True


def pods(s,kind='web'):
    allp=s.get('netpods') or {}
    if obj_bad(allp):return []
    items=allp.get('items',[])
    if kind=='web':return [p for p in items if obj_get(p,'metadata','labels',default={}).get('app')=='web']
    return [p for p in items if obj_get(p,'metadata','name')==kind]


def endpoints(s,which):
    v=s.get('dnseps' if which=='dns' else 'webeps') or {}
    if obj_bad(v):return []
    out=[]
    for item in v.get('items',[]):
        for e in item.get('endpoints',[]):
            if e.get('conditions',{}).get('ready') is not False:
                out.extend(e.get('addresses',[]))
    return out


def daemon_ready(d):
    st=obj_get(d,'status',default={})
    wanted=st.get('desiredNumberScheduled',0)
    return wanted>0 and st.get('numberReady',0)>=wanted and st.get('numberAvailable',0)>=wanted


def deployment_ready(d,count=1):
    st=obj_get(d,'status',default={})
    return st.get('availableReplicas',0)>=count and st.get('readyReplicas',0)>=count


def network_policy(s,name):
    v=s.get('policies') or {}
    if obj_bad(v):return None
    return next((p for p in v.get('items',[]) if obj_get(p,'metadata','name')==name),None)


def selector(s,which):
    svc=s.get('dnssvc' if which=='dns' else 'websvc')
    return obj_get(svc,'spec','selector',default={}) if isinstance(svc,dict) else {}


def healthy_http(s,target='web-svc'):
    if not pods(s,'net-client') or not ready_pod(pods(s,'net-client')[0]):return None
    rc,out,err=kube('exec','-n','net-lab','net-client','--','curl','-fsS','--max-time','4',f'http://{target}',timeout=9)
    if rc in (124,127):return None
    return rc==0 and ('nginx' in out.lower() or '<html' in out.lower() or '<!doctype' in out.lower())


def first_backend(s):
    web=next((p for p in pods(s) if ready_pod(p) and obj_get(p,'status','podIP')),None)
    return obj_get(web,'status','podIP')


def dns_lookup(s,host):
    if not pods(s,'dns-client') or not ready_pod(pods(s,'dns-client')[0]):return None
    rc,out,err=kube('exec','-n','net-lab','dns-client','--','nslookup',host,timeout=9)
    if rc in (124,127):return None
    return rc==0 and ('Name:' in out or 'Address:' in out or 'Non-authoritative answer' in out)


def resolv_dns(s):
    ds=s.get('dnssvc')
    ip=obj_get(ds,'spec','clusterIP')
    if not ip or not pods(s,'dns-client'):return False
    rc,out,err=kube('exec','-n','net-lab','dns-client','--','cat','/etc/resolv.conf')
    return rc==0 and any(line.strip()==f'nameserver {ip}' for line in out.splitlines())


def policy_deny_ok(s):
    p=network_policy(s,'deny-web-ingress')
    spec=obj_get(p,'spec',default={})
    return bool(p and obj_get(spec,'podSelector','matchLabels',default={}).get('app')=='web'
                and 'Ingress' in spec.get('policyTypes',[]) and not spec.get('ingress'))


def policy_allow_ok(s):
    p=network_policy(s,'allow-web-from-client')
    spec=obj_get(p,'spec',default={})
    if not p or obj_get(spec,'podSelector','matchLabels',default={}).get('app')!='web':return False
    if 'Ingress' not in spec.get('policyTypes',[]):return False
    rules=spec.get('ingress',[])
    if len(rules)!=1:return False
    r=rules[0]
    return (len(r.get('from',[]))==1
            and r['from'][0].get('podSelector',{}).get('matchLabels')=={'access':'web'}
            and len(r.get('ports',[]))==1
            and r['ports'][0].get('port')==80
            and r['ports'][0].get('protocol','TCP')=='TCP')


def fetch():
    # No truncar JSON. Read-only, sin depender de shell ni interpretar warnings como datos.
    s={}
    s['nodes']=get('nodes')
    s['proxyds']=get('daemonset','kube-proxy','kube-system')
    s['corednsdeploy']=get('deployment','coredns','kube-system')
    s['dnssvc']=get('service','kube-dns','kube-system')
    s['netns']=get('namespace','net-lab')
    s['webdeploy']=get('deployment','web','net-lab')
    s['websvc']=get('service','web-svc','net-lab')
    s['netpods']=get('pods',None,'net-lab')
    s['policies']=get('networkpolicies',None,'net-lab')
    # Selector de EndpointSlices, sin pasar datos sensibles por stdout.
    for k,ns,name in [('dnseps','kube-system','kube-dns'),('webeps','net-lab','web-svc')]:
        rc,out,err=kube('get','endpointslices','-n',ns,'-l',f'kubernetes.io/service-name={name}','-o','json')
        if rc:
            s[k]={'_error':err.strip()[:180]}
        else:
            try:s[k]=json.loads(out)
            except json.JSONDecodeError:s[k]={'_error':'JSON inválido'}
    return s


def empty_report():
    return {'version':VERSION,'lab':'l006','created_at':now(),'updated_at':now(),
            'phase':0,'events':[],'passed':{},'last':{},'snapshot_errors':[]}


def load():
    if REPORT.exists():
        try:
            a=json.loads(REPORT.read_text(encoding='utf-8'))
            if a.get('lab')=='l006' and isinstance(a.get('passed'),dict):return a
        except (OSError,ValueError):pass
    return empty_report()


def save(r):
    r['updated_at']=now()
    tmp=REPORT.with_suffix('.json.tmp')
    tmp.write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    os.replace(tmp,REPORT)


def passed(r,key):return key in r['passed']


def record(r,key,description=''):
    if not passed(r,key):
        r['passed'][key]={'at':now(),'description':description or CHECK_BY_ID[key][4]}


def setphase(r,value,message):
    if r['phase']<value:
        r['phase']=value
        r['events'].append({'at':now(),'phase':PHASES[value],'message':message})


def value_for(key,s,r):
    # True PASS, False condición aún no satisfecha, None NO VERIFICABLE (errores/transitorio).
    if key in ('nodes','final_nodes'):return ready_nodes(s)
    if key in ('proxy','proxy_ready'):return daemon_ready(s.get('proxyds'))
    if key=='coredns':return deployment_ready(s.get('corednsdeploy'))
    if key=='dns_svc':
        svc=s.get('dnssvc')
        return bool(svc and not obj_bad(svc) and obj_get(svc,'spec','type')=='ClusterIP'
                    and {'UDP','TCP'}.issubset({p.get('protocol') for p in obj_get(svc,'spec','ports',default=[]) if p.get('port')==53})
                    and len(endpoints(s,'dns'))>0)
    if key=='namespace':return s.get('netns') is not None and not obj_bad(s.get('netns'))
    if key=='web':return deployment_ready(s.get('webdeploy'),2)
    if key=='web_svc':
        v=s.get('websvc')
        return bool(v and obj_get(v,'spec','type')=='ClusterIP' and any(p.get('port')==80 and p.get('targetPort')==80 for p in obj_get(v,'spec','ports',default=[])))
    if key=='web_eps':return len(set(endpoints(s,'web')))>=2
    if key=='client':return bool(pods(s,'net-client') and ready_pod(pods(s,'net-client')[0]))
    if key in ('direct','svc_direct'):
        ip=first_backend(s)
        return healthy_http(s,ip) if ip else False
    if key=='dnsclient':return bool(pods(s,'dns-client') and ready_pod(pods(s,'dns-client')[0]))
    if key=='dns_k8s':return dns_lookup(s,'kubernetes.default')
    if key in ('dns_web','dns_lookup_restored'):
        return dns_lookup(s,'web-svc.net-lab.svc.cluster.local' if key=='dns_web' else 'kubernetes.default')
    if key=='resolv':return resolv_dns(s)
    if key=='selector':return selector(s,'web')=={'app':'web'}
    if key in ('baseline_http','svc_http_restored','allow_http'):
        if key=='baseline_http':
            x=healthy_http(s)
            if x is not True:return x
            return dns_lookup(s,'web-svc')
        return healthy_http(s)
    if key=='dns_bad':return selector(s,'dns').get('k8s-app')=='dns-broken'
    if key=='dns_noeps':return len(endpoints(s,'dns'))==0 and selector(s,'dns').get('k8s-app')=='dns-broken'
    if key in ('dns_restored','final_dns'):return selector(s,'dns').get('k8s-app')=='kube-dns'
    if key=='dns_eps_restored':return len(endpoints(s,'dns'))>0
    if key=='svc_bad':return selector(s,'web').get('app')=='web-broken'
    if key=='svc_noeps':return selector(s,'web').get('app')=='web-broken' and len(endpoints(s,'web'))==0
    if key=='svc_restored':return selector(s,'web')=={'app':'web'}
    if key=='svc_eps_restored':return len(set(endpoints(s,'web')))>=2
    if key=='deny_policy':return policy_deny_ok(s)
    if key=='blocked':
        if not policy_deny_ok(s) or not endpoints(s,'web') or selector(s,'web')!={'app':'web'}:
            return False
        if selector(s,'dns').get('k8s-app')!='kube-dns' or not endpoints(s,'dns'):
            return False
        x=healthy_http(s)
        return None if x is None else not x
    if key=='allow_policy':
        client=pods(s,'net-client')
        return policy_allow_ok(s) and bool(client and obj_get(client[0],'metadata','labels',default={}).get('access')=='web')
    if key=='final_system':return daemon_ready(s.get('proxyds')) and deployment_ready(s.get('corednsdeploy'))
    if key=='cleanup':
        if obj_bad(s.get('netns')):return None
        return s.get('netns') is None and selector(s,'dns').get('k8s-app')=='kube-dns' and ready_nodes(s)
    return None


def tick(r,active=True):
    s=fetch()
    errors=[f'{k}: {v["_error"]}' for k,v in s.items() if obj_bad(v)]
    r['snapshot_errors']=errors[:8]
    stage=r['phase']
    # Cada fase debe observarse en orden. No se acreditan fallas basándose únicamente en un estado final sano.
    if stage==0:
        # Capturar línea base hasta observar la primera falla.
        keys=[c[0] for c in CHECKS if c[3]=='pre']
    else:
        keys=[]
    if stage==1:keys=[c[0] for c in CHECKS if c[3]=='dns_fault']
    if stage==2:keys=[c[0] for c in CHECKS if c[3]=='dns_fixed']
    if stage==3:keys=[c[0] for c in CHECKS if c[3]=='svc_fault']
    if stage==4:keys=[c[0] for c in CHECKS if c[3]=='svc_fixed']
    if stage==5:keys=[c[0] for c in CHECKS if c[3]=='policy_deny']
    if stage==6:keys=[c[0] for c in CHECKS if c[3]=='policy_allow']
    if stage==7:keys=[c[0] for c in CHECKS if c[3]=='final']
    if stage==8:keys=[c[0] for c in CHECKS if c[3]=='cleanup']
    # No ejecutar pruebas de conectividad pesadas de forma ininterrumpida: solo cada ~32 segundos
    # en monitor. Con --tarea y --completo se ejecutan inmediatamente.
    expensive={'direct','dns_k8s','dns_web','resolv','baseline_http','dns_lookup_restored',
               'svc_direct','svc_http_restored','blocked','allow_http'}
    for key in keys:
        if passed(r,key):continue
        if not active and key in expensive:continue
        try:
            v=value_for(key,s,r)
        except Exception as ex:
            v=None
            r['last'][key]={'status':'UNVERIFIED','detail':str(ex)[:140],'at':now()}
        else:
            r['last'][key]={'status':'PASS' if v is True else 'PENDING' if v is False else 'UNVERIFIED','at':now()}
        if v is True:record(r,key)

    # Las transiciones exigen indicadores observados. Los puntos PASS son acumulativos.
    if stage==0 and selector(s,'dns').get('k8s-app')=='dns-broken' and any(passed(r,k) for k in ('dns_svc','baseline_http')):
        setphase(r,1,'Selector DNS alterado tras línea base registrada')
    elif stage==1 and passed(r,'dns_bad') and passed(r,'dns_noeps') and selector(s,'dns').get('k8s-app')=='kube-dns':
        setphase(r,2,'Selector DNS restaurado tras caída de endpoints')
    elif stage==2 and passed(r,'dns_restored') and passed(r,'dns_eps_restored') and passed(r,'dns_lookup_restored') and selector(s,'web').get('app')=='web-broken':
        setphase(r,3,'Selector Service alterado tras recuperación DNS')
    elif stage==3 and passed(r,'svc_bad') and passed(r,'svc_noeps') and selector(s,'web').get('app')=='web':
        setphase(r,4,'Selector Service restaurado tras caída de endpoints')
    elif stage==4 and passed(r,'svc_restored') and passed(r,'svc_eps_restored') and passed(r,'svc_http_restored') and policy_deny_ok(s):
        setphase(r,5,'Se observa política que bloquea ingress')
    elif stage==5 and passed(r,'deny_policy') and passed(r,'blocked') and policy_allow_ok(s):
        setphase(r,6,'Se observa excepción NetworkPolicy tras bloqueo')
    elif stage==6 and passed(r,'allow_policy') and passed(r,'allow_http'):
        setphase(r,7,'Conectividad restaurada con política de mínimo acceso')
    elif stage==7 and passed(r,'final_nodes') and passed(r,'final_dns') and passed(r,'final_system') and s.get('netns') is None:
        setphase(r,8,'Namespace de prueba eliminado; validando limpieza')
    # Registrar verificaciones tras cada transición sin esperar otra ejecución
    if r['phase']!=stage:
        nextkeys=[c[0] for c in CHECKS if c[3]==PHASES[r['phase']]]
        for key in nextkeys:
            try:v=value_for(key,s,r) if (active or key not in expensive) else None
            except Exception:v=None
            r['last'][key]={'status':'PASS' if v is True else 'PENDING' if v is False else 'UNVERIFIED','at':now()}
            if v is True:record(r,key)
    save(r)
    return r


def show(r,task=None):
    print(f'\nLAB 6 — EVALUACIÓN DE RED v{VERSION} (EVIDENCIAS ACUMULADAS)')
    print(f'  Fase detectada: {PHASES[r.get("phase",0)]}')
    total=0
    for t,(label,points) in TASKS.items():
        rows=[c for c in CHECKS if c[1]==t]
        score=sum(c[2] for c in rows if passed(r,c[0]))
        total+=score
        state='COMPLETADA' if score==points else 'NO INICIADA / SIN EVIDENCIA' if score==0 else 'EN PROGRESO'
        print(f'  Tarea {t}: {state:28} {score:2}/{points} pts | {label}')
        if task==t:
            for key,_,pts,phase,desc in rows:
                last=r.get('last',{}).get(key,{})
                status='PASS' if passed(r,key) else last.get('status','NO EVALUADA')
                print(f'    [{status}] {desc} ({pts} pts)')
    print(f'  PUNTOS ACREDITADOS: {total}/100')
    print('  NOTA: Provisional si faltan fases o evidencias; NO EVALUADA no equivale a fallo.')
    if r.get('snapshot_errors'):
        print('  Consultas pendientes:', '; '.join(r['snapshot_errors'][:2]))
    print('  El evaluador no cambia recursos Kubernetes ni guarda secretos.\n')


def monitor_alive():
    if not PIDFILE.exists():return False
    try:
        pid=int(PIDFILE.read_text().strip())
        if pid==os.getpid():return True
        os.kill(pid,0)
        return True
    except (OSError,ValueError):return False


def autoprueba():
    assert len(CHECKS)==36
    assert sum(c[2] for c in CHECKS)==100
    assert sum(c[2] for c in CHECKS if c[1]==5)==15
    assert sum(c[2] for c in CHECKS if c[1]==6)==15
    assert sum(c[2] for c in CHECKS if c[1]==7)==15
    assert ready_nodes({'nodes':{'items':[{'metadata':{'name':n},'status':{
        'conditions':[{'type':'Ready','status':'True'}],
        'addresses':[{'type':'InternalIP','address':'10.0.0.1'}]}}
        for n in ('cka-control','cka-worker1','cka-worker2')]}})
    assert policy_allow_ok({'policies':{'items':[{'metadata':{'name':'allow-web-from-client'},
        'spec':{'podSelector':{'matchLabels':{'app':'web'}},'policyTypes':['Ingress'],
        'ingress':[{'from':[{'podSelector':{'matchLabels':{'access':'web'}}}],
                   'ports':[{'protocol':'TCP','port':80}]}]}}]}})
    assert not policy_allow_ok({'policies':{'items':[]}})
    assert not network_policy({'policies':{'items':[]}},'missing')
    print(f'AUTOPRUEBA OK — v{VERSION}, {len(CHECKS)} comprobaciones, 8 tareas, 100 puntos; sin Kubernetes')


@contextmanager
def report_lock(timeout=90):
    # mkdir es atomico en Windows/Linux; evita perder evidencias por escrituras simultaneas.
    start=time.monotonic()
    while True:
        try:
            LOCKDIR.mkdir()
            (LOCKDIR/'pid').write_text(str(os.getpid()))
            break
        except FileExistsError:
            if time.monotonic()-start>timeout:
                raise RuntimeError('Evaluador ocupado: revisar el proceso de monitor y .evaluar_lab6.lock')
            time.sleep(.25)
    try:
        yield
    finally:
        (LOCKDIR/'pid').unlink(missing_ok=True)
        try: LOCKDIR.rmdir()
        except OSError:pass


def background():
    PIDFILE.write_text(str(os.getpid()))
    try:
        i=0
        while not STOPFILE.exists():
            try:
                with report_lock():
                    r=load()
                    tick(r,active=(i%4==0))
            except Exception as ex:
                print(f'{now()} ERROR: {str(ex)[:250]}',file=sys.stderr,flush=True)
            i+=1
            for _ in range(POLL):
                if STOPFILE.exists():break
                time.sleep(1)
    finally:
        PIDFILE.unlink(missing_ok=True)
        STOPFILE.unlink(missing_ok=True)


def main():
    p=argparse.ArgumentParser(description='Evaluador de red CKA Lab 6, solo lectura')
    g=p.add_mutually_exclusive_group(required=True)
    for a in ('--iniciar','--estado','--completo','--resumen','--detener','--autoprueba','--capturar'):
        g.add_argument(a,action='store_true')
    g.add_argument('--tarea',type=int,choices=range(1,9),metavar='1..8')
    g.add_argument('--_monitor',action='store_true',help=argparse.SUPPRESS)
    args=p.parse_args()
    if args.autoprueba:autoprueba();return
    if args._monitor:background();return
    if args.iniciar:
        if monitor_alive():print('Monitor ya está activo.');return
        STOPFILE.unlink(missing_ok=True)
        with LOGFILE.open('a',encoding='utf-8') as f:
            flags={}
            if os.name=='nt':flags['creationflags']=subprocess.CREATE_NEW_PROCESS_GROUP|subprocess.DETACHED_PROCESS
            else:flags['start_new_session']=True
            proc=subprocess.Popen([sys.executable,str(pathlib.Path(__file__).resolve()),'--_monitor'],
                                  cwd=str(HERE),stdin=subprocess.DEVNULL,stdout=f,stderr=f,**flags)
        PIDFILE.write_text(str(proc.pid))
        print(f'Monitor iniciado PID {proc.pid}. Intervalo {POLL}s; pruebas activas ~{POLL*4}s.')
        print('IMPORTANTE: comenzar ANTES de la Tarea 1 y mantener activo hasta la limpieza.')
        return
    if args.estado:
        r=load()
        print(f'Monitor: {"ACTIVO" if monitor_alive() else "DETENIDO"}. Fase: {PHASES[r.get("phase",0)]}. Reporte: {REPORT}')
        return
    if args.detener:
        if monitor_alive():
            STOPFILE.write_text(now())
            print('Detención solicitada; monitor finalizará en pocos segundos.')
        else:print('Monitor no está activo.')
        return
    if args.resumen:show(load());return
    with report_lock():
        r=load()
        tick(r,active=True)
    show(r,task=args.tarea)
    if args.capturar:print('Captura explícita guardada en',REPORT)

if __name__=='__main__':
    main()
