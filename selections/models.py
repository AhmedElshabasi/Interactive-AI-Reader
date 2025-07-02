from django.db import models
from django.contrib.auth.models import User

# Create your models here.

class Selection(models.Model):
    user = models.ForeignKey(User, on_delete=models.CASCADE)
    pdf_name = models.CharField(max_length=255)
    page_number = models.IntegerField()
    selected_text = models.TextField()
    coordinates = models.JSONField()  # Store selection coordinates if needed
    created_at = models.DateTimeField(auto_now_add=True)

    def __str__(self):
        return f"{self.user.username} - {self.pdf_name} - Page {self.page_number}"
