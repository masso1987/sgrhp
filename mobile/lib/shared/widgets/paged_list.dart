import 'package:flutter/material.dart';
import 'ui.dart';

/// One page of results from a server-paginated endpoint.
class PagedResult<T> {
  final List<T> items;
  final bool hasMore;
  const PagedResult(this.items, {this.hasMore = false});

  /// Build from the standard backend shape { items, page, pageSize, pages }.
  factory PagedResult.fromApi(Map data, T Function(dynamic) map) {
    final raw = (data['items'] as List?) ?? const [];
    final page = (data['page'] as num?)?.toInt() ?? 1;
    final pages = (data['pages'] as num?)?.toInt() ?? 1;
    return PagedResult<T>(raw.map(map).toList(), hasMore: page < pages);
  }
}

typedef PageFetcher<T> = Future<PagedResult<T>> Function(int page);

/// Infinite-scroll list bound to a server-paginated source. Never loads everything
/// at once — fetches the next page as the user nears the bottom. Pull to refresh.
class PagedListView<T> extends StatefulWidget {
  final PageFetcher<T> fetch;
  final Widget Function(BuildContext, T) itemBuilder;
  final IndexedWidgetBuilder? separatorBuilder;
  final EdgeInsets padding;
  final String emptyTitle;
  final String? emptySubtitle;
  final IconData emptyIcon;
  const PagedListView({
    super.key,
    required this.fetch,
    required this.itemBuilder,
    this.separatorBuilder,
    this.padding = const EdgeInsets.all(18),
    this.emptyTitle = 'Rien à afficher',
    this.emptySubtitle,
    this.emptyIcon = Icons.inbox_outlined,
  });
  @override
  State<PagedListView<T>> createState() => _PagedListViewState<T>();
}

class _PagedListViewState<T> extends State<PagedListView<T>> {
  final _items = <T>[];
  final _ctrl = ScrollController();
  int _page = 1;
  bool _loading = false;
  bool _hasMore = true;
  Object? _error;

  @override
  void initState() {
    super.initState();
    _ctrl.addListener(_onScroll);
    _load();
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  void _onScroll() {
    if (_ctrl.position.pixels >= _ctrl.position.maxScrollExtent - 300) _load();
  }

  Future<void> _load() async {
    if (_loading || !_hasMore) return;
    setState(() { _loading = true; _error = null; });
    try {
      final r = await widget.fetch(_page);
      _items.addAll(r.items);
      _hasMore = r.hasMore;
      _page++;
    } catch (e) {
      _error = e;
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _refresh() async {
    setState(() { _items.clear(); _page = 1; _hasMore = true; _error = null; });
    await _load();
  }

  @override
  Widget build(BuildContext context) {
    if (_items.isEmpty && _loading) return const Center(child: CircularProgressIndicator());
    if (_items.isEmpty && _error != null) return ErrorView(error: _error!, onRetry: _refresh);
    if (_items.isEmpty) {
      return RefreshIndicator(
        onRefresh: _refresh,
        child: ListView(children: [
          SizedBox(
            height: MediaQuery.of(context).size.height * 0.6,
            child: EmptyState(icon: widget.emptyIcon, title: widget.emptyTitle, subtitle: widget.emptySubtitle),
          ),
        ]),
      );
    }
    return RefreshIndicator(
      onRefresh: _refresh,
      child: ListView.separated(
        controller: _ctrl,
        padding: widget.padding,
        itemCount: _items.length + ((_hasMore || _loading) ? 1 : 0),
        separatorBuilder: widget.separatorBuilder ?? (_, __) => const SizedBox(height: 10),
        itemBuilder: (c, i) {
          if (i >= _items.length) {
            return const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()));
          }
          return widget.itemBuilder(c, _items[i]);
        },
      ),
    );
  }
}
