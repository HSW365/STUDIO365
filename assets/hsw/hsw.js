/* HSW365 site system: nav state, phone menu, and the pick-one tabs. */
(function () {
  var d = document;
  var nav = d.querySelector('.nav');
  var mnav = d.querySelector('.mnav');
  var btn = d.querySelector('.menu-btn');

  if (nav) {
    var onScroll = function () { nav.classList.toggle('solid', window.scrollY > 8); };
    window.addEventListener('scroll', onScroll, { passive: true });
    onScroll();
  }

  if (btn && mnav) {
    var setMenu = function (open) {
      mnav.classList.toggle('open', open);
      btn.setAttribute('aria-expanded', String(open));
    };
    btn.addEventListener('click', function () { setMenu(!mnav.classList.contains('open')); });
    mnav.addEventListener('click', function (e) { if (e.target.closest('a')) setMenu(false); });
    d.addEventListener('keydown', function (e) { if (e.key === 'Escape') setMenu(false); });
  }

  // tabs: buttons on the left choose the pane on the right
  [].forEach.call(d.querySelectorAll('.tabs'), function (box) {
    var tabs = [].slice.call(box.querySelectorAll('.tab'));
    var panes = [].slice.call(box.querySelectorAll('.pane'));
    var pick = function (i, focus) {
      tabs.forEach(function (t, n) {
        t.classList.toggle('on', n === i);
        t.setAttribute('aria-selected', String(n === i));
        t.tabIndex = n === i ? 0 : -1;
      });
      panes.forEach(function (p, n) { p.classList.toggle('on', n === i); });
      if (focus) tabs[i].focus();
    };
    tabs.forEach(function (t, i) {
      t.addEventListener('click', function () { pick(i); });
      t.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); pick((i + 1) % tabs.length, true); }
        if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); pick((i + tabs.length - 1) % tabs.length, true); }
      });
    });
  });

  // mark the section you are reading in the nav
  var links = [].slice.call(d.querySelectorAll('.nav-links a[href^="#"]'));
  if (links.length && 'IntersectionObserver' in window) {
    var byId = {};
    links.forEach(function (a) { byId[a.getAttribute('href').slice(1)] = a; });
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) {
        if (!en.isIntersecting) return;
        links.forEach(function (a) { a.classList.remove('active'); });
        var a = byId[en.target.id];
        if (a) a.classList.add('active');
      });
    }, { rootMargin: '-45% 0px -50% 0px' });
    Object.keys(byId).forEach(function (id) { var el = d.getElementById(id); if (el) io.observe(el); });
  }
})();
