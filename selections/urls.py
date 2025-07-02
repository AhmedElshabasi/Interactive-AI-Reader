from django.urls import path, include
from rest_framework.routers import DefaultRouter
from .views import SelectionViewSet

router = DefaultRouter()
router.register(r'selections', SelectionViewSet, basename='selection')

urlpatterns = [
    path('', include(router.urls)),
] 