"""Independent layer-shell bot surfaces sharing the main pet's WebKit process."""
import json
import secrets

class BotWindow:
    def __init__(self, runtime, identity, index, send, size=100):
        self.runtime, self.identity, self.send, self.index = runtime, identity, send, index
        self.size = size  # percent; the page zooms, the window and its hit/drag boxes follow
        self.current = None
        self.shape = None  # last page shape in CSS px; reapplied on resize (an idle page does not post it again)
        self.ready = False
        self.sent_sprite = None  # sheet id this page already holds; sheets travel once
        self.drag = None
        Gtk, layer, webkit = (runtime[k] for k in ('Gtk','GtkLayerShell','WebKit2'))
        self.win = Gtk.Window()
        self.win.set_default_size(280,240)
        self.win.set_decorated(False); self.win.set_app_paintable(True)
        visual=self.win.get_screen().get_rgba_visual()
        if visual: self.win.set_visual(visual)
        layer.init_for_window(self.win)
        layer.set_namespace(self.win,'talk-desktop-bot-'+identity)
        layer.set_layer(self.win,layer.Layer.OVERLAY)
        for edge in (layer.Edge.LEFT,layer.Edge.BOTTOM): layer.set_anchor(self.win,edge,True)
        self.place()
        layer.set_keyboard_mode(self.win,layer.KeyboardMode.NONE)
        layer.set_exclusive_zone(self.win,-1)
        self.manager=webkit.UserContentManager()
        self.manager.register_script_message_handler('companion')
        self.web=webkit.WebView(related_view=runtime['web'], user_content_manager=self.manager)
        self.web.set_size_request(280,240)
        settings=self.web.get_settings()
        settings.set_enable_media_stream(False); settings.set_enable_html5_local_storage(False)
        settings.set_enable_developer_extras(False)
        settings.set_hardware_acceleration_policy(webkit.HardwareAccelerationPolicy.NEVER)
        self.web.connect('permission-request',lambda view,request:(request.deny(),True)[1])
        self.web.connect('create',lambda *args:None)
        self.initial_navigation=True
        def navigation(view,decision,kind):
            if kind == webkit.PolicyDecisionType.NAVIGATION_ACTION:
                uri=decision.get_navigation_action().get_request().get_uri()
                if self.initial_navigation and uri in {'about:blank','file://'+str(runtime['root']/'companion')+'/'}:
                    self.initial_navigation=False;decision.use()
                else: decision.ignore()
                return True
            return False
        self.web.connect('decide-policy',navigation)
        rgba=runtime['Gdk'].RGBA(); rgba.parse('rgba(0,0,0,0)'); self.web.set_background_color(rgba)
        self.manager.connect('script-message-received::companion',self.message)
        root=runtime['root']/'companion'
        nonce=secrets.token_urlsafe(24)
        html=(root/'botview.html').read_text().replace('BOT_NONCE',nonce).replace('BOT_SCRIPT',runtime['shared']+'\n'+(root/'botview.js').read_text())
        self.web.load_html(html,'file://'+str(root)+'/')
        self.win.add(self.web)
        if size != 100: self.resize(size)
        self.win.show_all()
        if self.win.get_window(): self.place()  # realized: the monitor is known now

    def resize(self, size):
        self.size = size; f = size/100
        self.web.set_zoom_level(f)
        self.web.set_size_request(round(280*f),round(240*f)); self.win.resize(round(280*f),round(240*f))
        if self.shape is not None: self.dispatch({'type':'shape','rectangles':self.shape})
        self.runtime['keep_reachable'](self.runtime['GtkLayerShell'],self.runtime['Gdk'],self.win,(round(280*f),round(240*f)),tuple(v*f for v in (90,90,186,194)))

    def place(self):
        """Default spot by slot (also Reset bot positions); spacing follows the size.
        Once the monitor is known, rows wrap to its width and the window stays on it."""
        layer=self.runtime['GtkLayerShell']; f=self.size/100; step=round(220*f); box=(round(280*f),round(240*f)); columns=4; monitor=None
        if self.win.get_window():
            geometry=self.runtime['Gdk'].Display.get_default().get_monitor_at_window(self.win.get_window()).get_geometry()
            monitor=(geometry.width,geometry.height); columns=max(1,min(4,(monitor[0]-300-box[0])//step+1))
        spot=(300+self.index%columns*step,80+self.index//columns*step)
        if monitor: spot=tuple(min(v,max(0,m-s)) for v,m,s in zip(spot,monitor,box))
        layer.set_margin(self.win,layer.Edge.LEFT,spot[0])
        layer.set_margin(self.win,layer.Edge.BOTTOM,spot[1])

    def message(self, manager, result):
        try: self.dispatch(json.loads(result.get_js_value().to_string()))
        except (ValueError,TypeError,KeyError): pass

    def dispatch(self, data):
        kind=data.get('type')
        if kind=='ready':
            self.ready=True
            self.sent_sprite=None  # a (re)loaded page has no sheet yet
            if self.current: self.receive(self.current)
        elif kind=='command':
            command=data.get('command',{})
            if command.get('bot') == self.identity and command.get('action') in {'botChat','botDismiss'}:
                self.send(command)
        elif kind=='reveal':
            try: self.runtime['reveal_owner']()
            except Exception: pass  # compositor focus failure is not owner loss
        elif kind=='shape':
            f=self.size/100; rects=self.shape=data.get('rectangles')
            if isinstance(rects,list): rects=[[v*f for v in r] if isinstance(r,list) and all(type(v) in (int,float) for v in r) else r for r in rects]
            rectangles=self.runtime['normalize_regions'](rects,width=round(280*f),height=round(240*f))
            if rectangles and self.win.get_window():
                cairo=self.runtime['cairo'];region=cairo.Region()
                for rectangle in rectangles: region.union(cairo.RectangleInt(*rectangle))
                self.win.get_window().input_shape_combine_region(region,0,0)
        elif kind=='drag':
            runtime=self.runtime;layer=runtime['GtkLayerShell'];phase=data.get('phase')
            if phase=='start':
                geometry=runtime['Gdk'].Display.get_default().get_monitor_at_window(self.win.get_window()).get_geometry()
                self.drag=((layer.get_margin(self.win,layer.Edge.LEFT),layer.get_margin(self.win,layer.Edge.BOTTOM)),runtime['cursor_position'](),(geometry.width,geometry.height),(self.win.get_allocated_width(),self.win.get_allocated_height()))
            elif phase=='move' and self.drag:
                left,bottom=runtime['drag_margins'](self.drag[0],self.drag[1],runtime['cursor_position'](),self.drag[2],self.drag[3],tuple(v*self.size/100 for v in (90,90,186,194)))
                layer.set_margin(self.win,layer.Edge.LEFT,left);layer.set_margin(self.win,layer.Edge.BOTTOM,bottom)
            elif phase=='end': self.drag=None

    def receive(self, value):
        self.current=value
        pet=(value.get('bot') or {}).get('pet')
        ident=pet.get('spriteId') if isinstance(pet,dict) else None
        if ident != self.sent_sprite:
            # The page keeps a sheet only while snapshots name it. With no pet, or a new id
            # without bytes, it drops the sheet, so a later return must carry the bytes again.
            data=self.runtime.get('sprites',{}).get(ident) if self.ready and ident else None
            if data: value={**value,'bot':{**value['bot'],'pet':{**pet,'sprite':data}}}
            self.sent_sprite=ident if data else None
        self.web.evaluate_javascript('window.botReceive('+json.dumps(value)+')',-1,None,None,None,None,None)
